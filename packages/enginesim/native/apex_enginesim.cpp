// A C API over Open Engine Simulator's core, shaped for one caller: an AudioWorkletProcessor.
//
// WHY THIS FILE EXISTS. Upstream ships two browser-facing paths and neither is what a game wants.
// Its `engine-sim-web` target is the whole application — WebGL renderer, dashboard, input — built
// with `-sAUDIO_WORKLET -sWASM_WORKERS -pthread`, which forces COOP/COEP cross-origin isolation on
// whatever page embeds it. Corridor loads imagery and tiles from elsewhere, so isolating the whole
// document to get engine noise is the tail wagging the dog. The other path, the legacy PCM queue
// that `headless_main.cpp` drives, is `#if !defined(__EMSCRIPTEN__)`'d out of existence: in a wasm
// build `pumpAudioRendering()` returns false and `readAudioOutput()` memsets silence. Port that
// loop and you get a clean build, a running simulation, correct RPM telemetry, and no sound.
//
// So this binds the third path, the one upstream added for its worklet and left general: the
// simulation pushes samples into `Synthesizer::m_inputChannels[i].realtimeData`, a lock-free SPSC
// ring, and `renderRealtimeAudio()` pops them. Upstream runs the producer on the browser frame and
// the consumer in an audio worklet, which is why it needs shared memory. We run BOTH IN THE AUDIO
// THREAD — a single-producer/single-consumer queue does not care that the two are the same thread —
// and `es_render()` below drives the producer exactly as far as the consumer needs. One wasm
// instance, one thread, no SharedArrayBuffer, no cross-origin isolation, and the control-to-sound
// latency is one render quantum rather than a queue between two threads.
//
// The cost is that the physics now runs on the audio thread and must beat realtime there. That is
// measured, not assumed: see `scripts/measure.mjs`.
//
// Everything here is Apache-2.0 like the rest of this repo; it links MIT code by Ange Yaghi and the
// Open Engine Simulator contributors. See ../NOTICE.

#include "engine.h"
#include "impulse_response.h"
#include "simulator.h"
#include "synthesizer.h"
#include "transmission.h"
#include "units.h"
#include "vehicle.h"

#include "compiler.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define ES_API extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define ES_API extern "C"
#endif

namespace {

// Where `--embed-file` puts the upstream asset tree inside the module's virtual filesystem.
constexpr const char *AssetRoot = "/assets";

struct Instance {
    Engine *engine = nullptr;
    Vehicle *vehicle = nullptr;
    Transmission *transmission = nullptr;
    Simulator *simulator = nullptr;
    int sampleRate = 48000;
    // "Follow" mode holds the crankshaft at an RPM our own car physics decides, which is what a
    // game wants: one simulation owns the car and the engine only has to sound like it. Free mode
    // lets engine-sim drive its own vehicle through the gearbox, which is what the tuning editor
    // wants. See es_set_follow_rpm / es_set_free.
    bool follow = true;
    double followRpm = 0.0;
    // Taps kept from each exhaust's impulse response. ConvolutionFilter is a naive time-domain FIR,
    // so on paper this looks like the dominant cost — the stock `smooth_39` clips to ~7,500 taps
    // and a V8 has two exhausts, which is some 720 million multiplies a second. MEASURED, it is
    // not: once the FIR is vectorised the whole range from 7,500 taps down to 512 is worth about
    // 13% of a core, while the rigid-body solver and synthesis underneath cost ~33% no matter what
    // (scripts/measure.mjs prints the curve). Since the tail is nearly free and cutting below 2048
    // costs ~20 dB of timbre, the default keeps all of it. The knob stays because a weak machine
    // may still want it, not because it is the first thing to reach for; the first thing to reach
    // for is es_set_sim_frequency.
    int irLimit = 10000;
};

Instance g;
std::string g_error;
std::string g_name;

void setError(const std::string &message) { g_error = message; }

/* ---- impulse responses ----------------------------------------------------------------------- */

// Upstream reads these through SDL, which resamples on the way in. We have no SDL here and the
// library ships at 44.1 kHz while browsers commonly hand out a 48 kHz context, so the conversion
// has to happen somewhere. Doing it once to the impulse response is far cheaper and cleaner than
// resampling a continuous output stream, where any clock drift becomes an audible artifact.

struct Wav {
    std::vector<std::int16_t> samples;
    int sampleRate = 0;
    int channels = 0;
};

std::uint32_t readU32(const unsigned char *p) {
    return static_cast<std::uint32_t>(p[0]) | (static_cast<std::uint32_t>(p[1]) << 8)
        | (static_cast<std::uint32_t>(p[2]) << 16) | (static_cast<std::uint32_t>(p[3]) << 24);
}

std::uint16_t readU16(const unsigned char *p) {
    return static_cast<std::uint16_t>(static_cast<std::uint16_t>(p[0])
        | (static_cast<std::uint16_t>(p[1]) << 8));
}

bool readWav(const std::string &path, Wav &out) {
    std::ifstream file(path, std::ios::binary);
    if (!file) return false;
    std::vector<unsigned char> data(
        (std::istreambuf_iterator<char>(file)), std::istreambuf_iterator<char>());
    if (data.size() < 44 || std::memcmp(data.data(), "RIFF", 4) != 0
        || std::memcmp(data.data() + 8, "WAVE", 4) != 0) {
        return false;
    }

    std::uint16_t format = 0, bits = 0;
    std::size_t cursor = 12;
    bool haveFormat = false, haveData = false;
    while (cursor + 8 <= data.size()) {
        const unsigned char *id = data.data() + cursor;
        const std::uint32_t size = readU32(data.data() + cursor + 4);
        const std::size_t body = cursor + 8;
        if (body + size > data.size()) break;
        if (std::memcmp(id, "fmt ", 4) == 0 && size >= 16) {
            format = readU16(data.data() + body);
            out.channels = readU16(data.data() + body + 2);
            out.sampleRate = static_cast<int>(readU32(data.data() + body + 4));
            bits = readU16(data.data() + body + 14);
            haveFormat = true;
        } else if (std::memcmp(id, "data", 4) == 0) {
            out.samples.resize(size / sizeof(std::int16_t));
            std::memcpy(out.samples.data(), data.data() + body, out.samples.size() * 2);
            haveData = true;
        }
        cursor = body + size + (size & 1U);
    }
    return haveFormat && haveData && format == 1 && bits == 16 && out.channels >= 1
        && !out.samples.empty();
}

// Windowed-sinc resample, 32 taps, Blackman window. Overkill for a room impulse but it is twenty
// lines and it keeps the exhaust's high end from picking up the ringing that linear interpolation
// leaves behind, which on a convolution tail is audible as a metallic edge.
void resample(const std::vector<std::int16_t> &in, int inRate, int outRate, int channels,
    std::vector<std::int16_t> &out)
{
    const std::size_t frames = in.size() / static_cast<std::size_t>(channels);
    if (inRate == outRate && channels == 1) { out = in; return; }

    const double ratio = static_cast<double>(outRate) / inRate;
    const std::size_t outFrames = static_cast<std::size_t>(std::floor(frames * ratio));
    // Downsampling has to band-limit to the NEW Nyquist or it folds; upsampling keeps the original.
    const double cutoff = std::min(1.0, ratio);
    constexpr int halfTaps = 16;
    out.assign(outFrames, 0);

    for (std::size_t i = 0; i < outFrames; ++i) {
        const double centre = i / ratio;
        const long base = static_cast<long>(std::floor(centre));
        double sum = 0.0, weight = 0.0;
        for (int k = -halfTaps + 1; k <= halfTaps; ++k) {
            const long index = base + k;
            if (index < 0 || static_cast<std::size_t>(index) >= frames) continue;
            const double x = centre - index;
            const double sinc = std::abs(x) < 1e-9
                ? cutoff
                : cutoff * std::sin(M_PI * cutoff * x) / (M_PI * cutoff * x);
            const double w = 0.5 - 0.5 * std::cos(M_PI * (x + halfTaps) / halfTaps);
            const double tap = sinc * w;
            // Mix any extra channels down; the library is mono but this keeps a stereo file usable.
            double sample = 0.0;
            for (int c = 0; c < channels; ++c) {
                sample += in[static_cast<std::size_t>(index) * channels + c];
            }
            sum += (sample / channels) * tap;
            weight += tap;
        }
        const double value = weight > 1e-9 ? sum / weight : 0.0;
        out[i] = static_cast<std::int16_t>(
            std::max(-32768.0, std::min(32767.0, std::round(value))));
    }
}

bool loadImpulseResponses() {
    for (int index = 0; index < g.engine->getExhaustSystemCount(); ++index) {
        ImpulseResponse *response = g.engine->getExhaustSystem(index)->getImpulseResponse();
        if (response == nullptr) continue;
        Wav wav;
        if (!readWav(response->getFilename(), wav)) {
            setError("Cannot read impulse response: " + response->getFilename());
            return false;
        }
        std::vector<std::int16_t> converted;
        resample(wav.samples, wav.sampleRate, g.sampleRate, wav.channels, converted);
        // initializeImpulseResponse trims to the last sample above its own noise floor and caps at
        // 10000, so handing it a shorter buffer is all that is needed to shorten the tail.
        if (static_cast<int>(converted.size()) > g.irLimit) {
            converted.resize(static_cast<std::size_t>(g.irLimit));
        }
        g.simulator->synthesizer().initializeImpulseResponse(
            converted.data(), static_cast<unsigned int>(converted.size()),
            static_cast<float>(response->getVolume()), index);
    }
    return true;
}

/* ---- teardown -------------------------------------------------------------------------------- */

void releaseSimulation() {
    if (g.simulator != nullptr) {
        g.simulator->releaseSimulation();
        delete g.simulator;
        g.simulator = nullptr;
    }
    if (g.engine != nullptr) { g.engine->destroy(); delete g.engine; g.engine = nullptr; }
    delete g.vehicle; g.vehicle = nullptr;
    delete g.transmission; g.transmission = nullptr;
}

// Piranha resolves `import` relative to a search path and an entry file, so compiling one engine
// means synthesising a two-line entry that imports it and calls `main()`. Upstream's headless tool
// does the same thing through the OS temp directory; ours goes to the module's own MEMFS.
bool compileEntry(const std::string &entrySource) {
    releaseSimulation();

    const char *entryPath = "/tmp/apex-enginesim-entry.mr";
    {
        std::ofstream file(entryPath);
        if (!file) { setError("Cannot stage the compiler entry file"); return false; }
        file << entrySource;
    }

    es_script::Compiler compiler;
    compiler.initialize(AssetRoot);
    const bool compiled = compiler.compile(entryPath);
    if (!compiled) {
        // Piranha reports diagnostics by writing this file next to the working directory rather
        // than returning them, so the only way to give the editor a real message is to read it back.
        std::ifstream log("error_log.log");
        std::stringstream text;
        text << log.rdbuf();
        compiler.destroy();
        setError(text.str().empty() ? "Engine script failed to compile" : text.str());
        return false;
    }

    const es_script::Compiler::Output output = compiler.execute();
    compiler.destroy();
    if (output.engine == nullptr || output.vehicle == nullptr || output.transmission == nullptr) {
        setError("Engine script compiled but produced no engine, vehicle or transmission");
        return false;
    }

    g.engine = output.engine;
    g.vehicle = output.vehicle;
    g.transmission = output.transmission;
    g.simulator = g.engine->createSimulator(g.vehicle, g.transmission, g.sampleRate);
    g.engine->calculateDisplacement();
    g.simulator->setSimulationFrequency(static_cast<int>(g.engine->getSimulationFrequency()));
    // The reservoir correction exists for hosts that run the simulation on a variable-rate frame
    // clock and have to catch up. We produce exactly what the audio callback asks for, so letting
    // it stretch or shrink the step count would only bend the pitch.
    g.simulator->setSynthesizerLatencyCorrectionEnabled(false);
    g.simulator->setMaximumSynthesizerInputLatency(-1.0);
    // Sets Synthesizer::m_run. Despite the name it starts no thread in a wasm build; without it
    // renderRealtimeAudio() short-circuits to silence.
    g.simulator->startAudioRenderingThread();

    if (!loadImpulseResponses()) { releaseSimulation(); return false; }

    g.engine->getIgnitionModule()->m_enabled = true;
    g.transmission->setClutchPressure(1.0);
    g.simulator->m_dyno.m_enabled = g.follow;
    g.simulator->m_dyno.m_hold = g.follow;
    g.simulator->m_dyno.m_rotationSpeed = 0.0;
    g_name = g.engine->getName();
    g_error.clear();
    return true;
}

SpscAudioRing<float> *inputRing() {
    Synthesizer &synth = g.simulator->synthesizer();
    if (synth.m_inputChannelCount == 0) return nullptr;
    return &synth.m_inputChannels[0].realtimeData;
}

} // namespace

/* ---- lifecycle ------------------------------------------------------------------------------- */

ES_API int es_init(int sampleRate) {
    if (sampleRate < 8000 || sampleRate > 192000) {
        setError("Unsupported sample rate");
        return 0;
    }
    g.sampleRate = sampleRate;
    g_error.clear();
    return 1;
}

/** Compile one of the embedded engine scripts, e.g. "engines/atg-video-2/07_gm_ls.mr". */
ES_API int es_load(const char *scriptPath) {
    std::string path(scriptPath == nullptr ? "" : scriptPath);
    if (path.empty()) { setError("No engine script given"); return 0; }
    std::string entry = "import \"" + std::string(AssetRoot) + "/" + path + "\"\n\nmain()\n";
    return compileEntry(entry) ? 1 : 0;
}

/**
 * Compile engine script source handed over at runtime. This is the editor's hot-reload path: the
 * asset tool edits a .mr in the browser and applies it without a round trip through a file.
 */
ES_API int es_load_source(const char *source) {
    if (source == nullptr) { setError("No engine source given"); return 0; }
    const char *sourcePath = "/tmp/apex-enginesim-source.mr";
    {
        std::ofstream file(sourcePath);
        if (!file) { setError("Cannot stage the engine source"); return 0; }
        file << source;
    }
    std::string entry = "import \"" + std::string(sourcePath) + "\"\n\nmain()\n";
    return compileEntry(entry) ? 1 : 0;
}

ES_API void es_shutdown(void) { releaseSimulation(); }

ES_API const char *es_error(void) { return g_error.c_str(); }

ES_API const char *es_name(void) { return g_name.c_str(); }

/* ---- audio ----------------------------------------------------------------------------------- */

/**
 * Fill `frames` mono samples and advance the simulation by exactly that much time.
 *
 * Called from the audio thread with `frames` = 128 (a Web Audio render quantum). Allocation-free:
 * everything it touches was sized at load.
 */
ES_API int es_render(float *out, int frames) {
    if (g.simulator == nullptr || frames <= 0) {
        if (out != nullptr && frames > 0) std::fill(out, out + frames, 0.0f);
        return 0;
    }

    SpscAudioRing<float> *ring = inputRing();
    if (ring == nullptr) { std::fill(out, out + frames, 0.0f); return 0; }

    if (g.follow) {
        const double held = units::rpm(g.followRpm);
        g.simulator->m_dyno.m_rotationSpeed = std::max(0.0,
            std::min(held, g.engine->getDynoMaxSpeed()));
    }

    // Produce until the ring can satisfy this quantum. One simulation step is the floor: a deficit
    // of a couple of samples rounds to zero steps in startFrame() and this would spin forever.
    const double stepSeconds = 1.0 / std::max(1, g.simulator->getSimulationFrequency());
    int guard = 0;
    while (static_cast<int>(ring->size()) < frames && guard++ < 1024) {
        const int deficit = frames - static_cast<int>(ring->size());
        const double dt = std::max(deficit / static_cast<double>(g.sampleRate), stepSeconds);
        g.simulator->startFrame(dt);
        while (g.simulator->simulateStep()) { }
        g.simulator->endFrame();
    }

    g.simulator->synthesizer().renderRealtimeAudio(out, frames);
    return frames;
}

/* ---- controls -------------------------------------------------------------------------------- */

/**
 * The pedal, 0..1. This is `setSpeedControl`, not `setThrottle`: the former goes through whatever
 * throttle linkage or governor the script declared, which is what the desktop app's Q/W/E/R keys
 * drive and therefore what an engine is voiced against. `setThrottle` writes the intake plates
 * directly and bypasses that.
 */
ES_API void es_set_pedal(double value) {
    if (g.engine == nullptr) return;
    g.engine->setSpeedControl(std::max(0.0, std::min(1.0, value)));
}

ES_API void es_set_ignition(int on) {
    if (g.engine == nullptr) return;
    g.engine->getIgnitionModule()->m_enabled = on != 0;
}

ES_API void es_set_starter(int on) {
    if (g.simulator == nullptr) return;
    g.simulator->m_starterMotor.m_enabled = on != 0;
}

/** 1 is fully engaged, 0 is the clutch in. Smooth this on the caller's side; a step is audible. */
ES_API void es_set_clutch(double pressure) {
    if (g.transmission == nullptr) return;
    g.transmission->setClutchPressure(std::max(0.0, std::min(1.0, pressure)));
}

ES_API void es_set_gear(int gear) {
    if (g.transmission == nullptr) return;
    g.transmission->changeGear(gear);
}

/**
 * Follow mode: hold the crankshaft at an RPM someone else computed. Corridor's `Car` already
 * integrates its own drivetrain, and two physics simulations arguing over one car is how you get an
 * engine note that lags and hunts. Here our car stays authoritative and engine-sim only voices it.
 */
ES_API void es_set_follow_rpm(double rpm) {
    g.follow = true;
    g.followRpm = std::max(0.0, rpm);
    if (g.simulator != nullptr) {
        g.simulator->m_dyno.m_enabled = true;
        g.simulator->m_dyno.m_hold = true;
    }
}

/** Free mode: engine-sim drives its own vehicle through its own gearbox. The editor's dyno. */
ES_API void es_set_free(int dynoEnabled, int dynoHold, double dynoRpm) {
    g.follow = false;
    if (g.simulator == nullptr) return;
    g.simulator->m_dyno.m_enabled = dynoEnabled != 0;
    g.simulator->m_dyno.m_hold = dynoHold != 0;
    g.simulator->m_dyno.m_rotationSpeed = units::rpm(dynoRpm);
}

/**
 * Cap the exhaust convolution tail, in samples. Takes effect on the next load, because changing it
 * reallocates the filter and that must not happen on the audio thread. 0 is not allowed; to turn
 * the convolution off entirely set the `convolution` audio parameter to 0, which upstream already
 * short-circuits without touching the filter.
 */
ES_API void es_set_ir_limit(int samples) {
    g.irLimit = std::max(64, std::min(10000, samples));
}

ES_API int es_ir_limit(void) { return g.irLimit; }

ES_API void es_set_sim_frequency(int hz) {
    if (g.simulator == nullptr) return;
    g.simulator->setSimulationFrequency(std::max(400, std::min(400000, hz)));
}

/* ---- synthesizer knobs ----------------------------------------------------------------------- */
//
// Indices rather than ten entry points, because the editor drives these generically from a table
// and every one of them is a float. Keep in sync with AUDIO_PARAMS in ../src/params.ts.

enum AudioParam {
    ParamVolume = 0,
    ParamConvolution = 1,
    ParamHighFrequencyGain = 2,
    ParamHighFrequencyNoise = 3,
    ParamHighFrequencyNoiseCutoff = 4,
    ParamLowFrequencyNoise = 5,
    ParamLowFrequencyNoiseCutoff = 6,
    ParamLevelerTarget = 7,
    ParamLevelerMaxGain = 8,
    ParamLevelerMinGain = 9,
};

ES_API void es_set_audio_param(int id, double value) {
    if (g.simulator == nullptr) return;
    Synthesizer::AudioParameters p = g.simulator->synthesizer().getAudioParameters();
    const float v = static_cast<float>(value);
    switch (id) {
        case ParamVolume: p.volume = v; break;
        case ParamConvolution: p.convolution = v; break;
        case ParamHighFrequencyGain: p.dF_F_mix = v; break;
        case ParamHighFrequencyNoise: p.inputSampleNoise = v; break;
        case ParamHighFrequencyNoiseCutoff: p.inputSampleNoiseFrequencyCutoff = v; break;
        case ParamLowFrequencyNoise: p.airNoise = v; break;
        case ParamLowFrequencyNoiseCutoff: p.airNoiseFrequencyCutoff = v; break;
        case ParamLevelerTarget: p.levelerTarget = v; break;
        case ParamLevelerMaxGain: p.levelerMaxGain = v; break;
        case ParamLevelerMinGain: p.levelerMinGain = v; break;
        default: return;
    }
    g.simulator->synthesizer().setAudioParameters(p);
}

ES_API double es_get_audio_param(int id) {
    if (g.simulator == nullptr) return 0.0;
    const Synthesizer::AudioParameters p = g.simulator->synthesizer().getAudioParameters();
    switch (id) {
        case ParamVolume: return p.volume;
        case ParamConvolution: return p.convolution;
        case ParamHighFrequencyGain: return p.dF_F_mix;
        case ParamHighFrequencyNoise: return p.inputSampleNoise;
        case ParamHighFrequencyNoiseCutoff: return p.inputSampleNoiseFrequencyCutoff;
        case ParamLowFrequencyNoise: return p.airNoise;
        case ParamLowFrequencyNoiseCutoff: return p.airNoiseFrequencyCutoff;
        case ParamLevelerTarget: return p.levelerTarget;
        case ParamLevelerMaxGain: return p.levelerMaxGain;
        case ParamLevelerMinGain: return p.levelerMinGain;
        default: return 0.0;
    }
}

/* ---- telemetry ------------------------------------------------------------------------------- */

ES_API double es_rpm(void) { return g.engine == nullptr ? 0.0 : g.engine->getRpm(); }
ES_API double es_pedal(void) { return g.engine == nullptr ? 0.0 : g.engine->getSpeedControl(); }
ES_API double es_manifold_pressure(void) {
    return g.engine == nullptr ? 0.0 : g.engine->getManifoldPressure();
}
ES_API double es_vehicle_speed(void) { return g.vehicle == nullptr ? 0.0 : g.vehicle->getSpeed(); }
ES_API int es_gear(void) { return g.transmission == nullptr ? -1 : g.transmission->getGear(); }
ES_API double es_torque(void) {
    return g.simulator == nullptr ? 0.0 : g.simulator->getFilteredDynoTorque();
}
ES_API double es_power(void) { return g.simulator == nullptr ? 0.0 : g.simulator->getDynoPower(); }
ES_API int es_cylinders(void) { return g.engine == nullptr ? 0 : g.engine->getCylinderCount(); }
ES_API double es_redline(void) { return g.engine == nullptr ? 0.0 : g.engine->getRedline(); }
ES_API double es_displacement(void) {
    return g.engine == nullptr ? 0.0 : g.engine->getDisplacement();
}
ES_API int es_sim_frequency(void) {
    return g.simulator == nullptr ? 0 : g.simulator->getSimulationFrequency();
}
