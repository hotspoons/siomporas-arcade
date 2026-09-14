-- Per-character move definitions for the plan generator. Inputs use fwd/back so they work either side.
-- A special is {id, button="P"|"K", motion=list of {frames, inputs} with "@" standing for the button,
-- dist=distance for the hit/block tests, frames=how long to record, proj=true if it spawns a projectile}.
local qcf = function() return {{3,"down"},{3,"down,fwd"},{3,"fwd"},{2,"fwd,@"}} end
local qcb = function() return {{3,"down"},{3,"down,back"},{3,"back"},{2,"back,@"}} end
local dp  = function() return {{3,"fwd"},{3,"down"},{3,"down,fwd"},{2,"down,fwd,@"}} end
local hcf = function() return {{3,"back"},{3,"down,back"},{3,"down"},{3,"down,fwd"},{3,"fwd"},{2,"fwd,@"}} end
local hcb = function() return {{3,"fwd"},{3,"down,fwd"},{3,"down"},{3,"down,back"},{3,"back"},{2,"back,@"}} end
-- Charge moves: the game wants the new direction seen for a frame or two before the button (the
-- release-and-press read happens on the direction change), and the charge itself must last >= ~60f.
local chargeB = function(n) return {{n or 80,"back"},{3,"fwd"},{2,"fwd,@"}} end
local chargeD = function(n) return {{n or 80,"down"},{1,"up"},{2,"up,@"}} end
local mash = function(n) local s = {} for i = 1, (n or 8) do s[#s+1] = {2,"@"}; s[#s+1] = {2,""} end return s end
local spin360 = function() return {{2,"fwd"},{2,"down,fwd"},{2,"down"},{2,"down,back"},{2,"back"},{2,"up,back"},{2,"up,@"},{1,"@"}} end

return {
  ryu = {
    specials = {
      {id="hadouken",  button="P", motion=qcf(), dist=120, frames=150, proj=true},
      {id="shoryuken", button="P", motion=dp(),  dist=40,  frames=150},
      {id="tatsumaki", button="K", motion=qcb(), dist=60,  frames=200},
    },
  },
  ken = {
    specials = {
      {id="hadouken",  button="P", motion=qcf(), dist=120, frames=150, proj=true},
      {id="shoryuken", button="P", motion=dp(),  dist=40,  frames=150},
      {id="tatsumaki", button="K", motion=qcb(), dist=60,  frames=200},
    },
  },
  zangief = {
    specials = {
      {id="spd",    button="P", motion=spin360(), dist=40, frames=200, throw=true},
      {id="lariat", button="P", motion={{2,"lp,mp,hp"},{1,""}}, dist=50, frames=200, buttons={"ppp"}},
      -- the kick lariat (KKK) only exists from Hyper Fighting on
    },
  },
  blanka = {
    specials = {
      {id="rolling",     button="P", motion=chargeB(70), dist=120, frames=200},
      {id="electricity", button="P", motion=mash(8),     dist=40,  frames=200},
      -- the vertical rolling attack (charge down, up+K) only exists from Hyper Fighting on
    },
  },
  honda = {
    specials = {
      {id="headbutt", button="P", motion=chargeB(70), dist=120, frames=200},
      {id="hands",    button="P", motion=mash(6),     dist=40,  frames=200},
    },
  },
  guile = {
    specials = {
      {id="sonicboom", button="P", motion=chargeB(70), dist=120, frames=200, proj=true},
      {id="flashkick", button="K", motion=chargeD(70), dist=40,  frames=200},
    },
  },
  chunli = {
    specials = {
      {id="lightning", button="K", motion=mash(6),     dist=40, frames=200},
      {id="sbk",       button="K", motion=chargeD(70), dist=60, frames=200},
    },
  },
  dhalsim = {
    specials = {
      {id="yogafire",  button="P", motion=hcf(), dist=150, frames=200, proj=true},
      {id="yogaflame", button="P", motion=hcb(), dist=50,  frames=200},
    },
  },
  bison = {
    specials = {
      {id="psychocrusher", button="P", motion=chargeB(70), dist=120, frames=200},
      {id="scissors",      button="K", motion=chargeB(70), dist=90,  frames=200},
      {id="headstomp",     button="K", motion=chargeD(70), dist=60,  frames=200},
    },
  },
  sagat = {
    specials = {
      {id="tigershot-high", button="P", motion=qcf(), dist=120, frames=150, proj=true},
      {id="tigershot-low",  button="K", motion=qcf(), dist=120, frames=150, proj=true},
      {id="tigeruppercut",  button="P", motion=dp(),  dist=40,  frames=150},
      {id="tigerknee",      button="K", motion=dp(),  dist=60,  frames=150},
    },
  },
  balrog = {
    specials = {
      {id="dashpunch",    button="P", motion=chargeB(70), dist=120, frames=200},
      {id="dashuppercut", button="K", motion=chargeB(70), dist=120, frames=200},
      {id="turnpunch",    button="P", motion={{40,"lp,mp,hp"},{2,""}}, dist=80, frames=200, buttons={"ppp"}},
    },
  },
  vega = {
    specials = {
      {id="crystalflash", button="P", motion=chargeB(70), dist=100, frames=200},
      {id="flipkick",     button="K", motion=chargeD(70), dist=50,  frames=200},
    },
  },
}
