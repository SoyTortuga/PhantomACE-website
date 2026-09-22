-- Slices a flat NxM sprite-sheet PNG (no existing Aseprite project, no
-- frame/tag metadata -- just rows and columns of a grid, the common shape
-- an itch.io effect pack ships in) into a real multi-frame .aseprite file,
-- one tag per row.
--
-- Exists because Aseprite's own interactive "Import Sprite Sheet" dialog
-- has no reliable batch/headless equivalent across versions worth
-- depending on -- this builds the frames directly with the same Image/Cel
-- API the dialog itself uses underneath, so it works the same way in
-- --batch mode every time.
--
--   Aseprite -b --script-param path=IN.png --script-param out=OUT.aseprite \
--     --script-param fw=300 --script-param fh=256 \
--     --script-param cols=9 --script-param rows=5 \
--     --script-param names="charge,rise,peak,fade,tail" \
--     --script-param duration=80 \
--     --script server/scripts/lib/aseprite-slice-sheet.lua
--
-- `names` is one tag name per row, comma-separated, top to bottom -- there
-- is no way to infer what a row MEANS from the grid alone, so this is
-- always given explicitly rather than guessed ("row3").

local params = app.params

local path = params["path"]
local outPath = params["out"]
local fw = tonumber(params["fw"])
local fh = tonumber(params["fh"])
local cols = tonumber(params["cols"])
local rows = tonumber(params["rows"])
local duration = tonumber(params["duration"] or "100") / 1000.0
local rowNames = {}
for name in string.gmatch(params["names"] or "", "([^,]+)") do
  table.insert(rowNames, name)
end

if not path or not outPath or not fw or not fh or not cols or not rows then
  error("Missing required --script-param: path, out, fw, fh, cols, rows")
end
if #rowNames ~= rows then
  error("--script-param names must list exactly " .. rows .. " comma-separated name(s), got " .. #rowNames)
end

local sheet = app.open(path)
if not sheet then error("Could not open " .. path) end
local sheetImage = Image(sheet.spec)
sheetImage:drawSprite(sheet, 1)

-- A fresh sprite, same pixel format and canvas as one grid cell, RGBA so
-- the transparent gaps around each frame's art survive.
local out = Sprite(fw, fh, ColorMode.RGB)
out.filename = outPath
local layer = out.layers[1]

-- ALL frames built first, tags added only once the sprite is at its final
-- frame count. A tag created while more frames are still to be appended
-- gets its `to` silently re-pinned to whatever the CURRENT last frame is
-- every time a new frame is added after it -- verified the hard way: every
-- row's tag but the last ended up spanning all the way to frame 45. */
local totalFrames = cols * rows
local frameIndex = 0
for r = 0, rows - 1 do
  for c = 0, cols - 1 do
    local cel
    if frameIndex == 0 then
      cel = out:newCel(layer, out.frames[1])
    else
      out:newEmptyFrame()
      cel = out:newCel(layer, out.frames[#out.frames])
    end
    local region = Rectangle(c * fw, r * fh, fw, fh)
    local cellImage = Image(fw, fh, ColorMode.RGB)
    cellImage:drawImage(sheetImage, Point(-region.x, -region.y))
    cel.image = cellImage
    out.frames[frameIndex + 1].duration = duration
    frameIndex = frameIndex + 1
  end
end

for r = 0, rows - 1 do
  local tagFrom = r * cols + 1
  local tagTo = tagFrom + cols - 1
  out:newTag(tagFrom, tagTo).name = rowNames[r + 1]
end

out:saveAs(outPath)
print("Wrote " .. outPath .. ": " .. totalFrames .. " frames (" .. cols .. "x" .. rows .. "), tags: " .. table.concat(rowNames, ", "))
sheet:close()
