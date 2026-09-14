-- Plan entry: PROBE_CHAR=ryu selects the character definition; PROBE_REPS the repeat count.
PROBE_DIR = os.getenv("PROBE_DIR") or "."
local G = dofile(PROBE_DIR .. "/plans/gen.lua")
local ch = os.getenv("PROBE_CHAR") or "ryu"
local opts = { reps = tonumber(os.getenv("PROBE_REPS") or "3") }
local plan = G.build(ch, opts)
plan.name = (os.getenv("PROBE_PLAN_NAME") or ch)
return plan
