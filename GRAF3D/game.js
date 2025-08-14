<script>
/* =========================================================================
   Spray Doom: NY’90s — single-file raycasting game
   Patch notes:
   - Roads are clean asphalt (no lane dashes).
   - Crosswalks: placed OCCASIONALLY at intersections (probabilistic) and
     limited to tiny bands so they don't spread along entire streets.
   - Vehicle sprites: front/back depending on whether car approaches the player.
   - Floor casting alignment preserved; stability checks/logging added.
   ======================================================================= */

/* ========= Utils ========= */
function clamp(x,a,b){ return x<a?a:(x>b?b:x); }
function dist2(ax,ay,bx,by){ const dx=ax-bx,dy=ay-by; return dx*dx+dy*dy; }
function randi(a,b){ return (Math.random()*(b-a+1)|0)+a; }
function inBounds(arr,x,y){ return y>=0 && y<arr.length && x>=0 && x<arr[0].length; }
function makeRNG(seed){ let t=seed>>>0; return function(){ t+=0x6D2B79F5; let r=Math.imul(t^t>>>15,1|t); r^=r+Math.imul(r^r>>>7,61|r); return ((r^r>>>14)>>>0)/4294967296; }; }

/* ========= Canvas / globals ========= */
const view = document.getElementById('view');
const ctx = view.getContext('2d', { alpha:false });
const W = view.width, H = view.height;
const HALF_W = W>>1, HALF_H = H>>1;
ctx.imageSmoothingEnabled = false;

const minimap = document.getElementById('minimap');
const mctx = minimap.getContext('2d', { alpha:true });
mctx.imageSmoothingEnabled = false;

let paused = false;

/* ========= World constants ========= */
const TILE = 1.0;
const PLAYER_RADIUS = 0.25;
const FOV = Math.PI * 0.66;
const MOVE_SPEED = 2.2, STRAFE_SPEED = 2.0, ROT_SPEED = 2.3;
const SPRAY_RANGE = 3.0, SPRAY_ANGLE = Math.PI/8;
const CAR_RADIUS = 0.35, NPC_RADIUS = 0.25;
const STUN_TIME = 2.5;
const DAMAGE_FROM_CAR = 10, DAMAGE_FROM_COP_TOUCH = 6;
const ROAD_SPEED_MULT = 1.1;

/* ========= Data ========= */
let RNG = Math.random;
let SEED = (Date.now() ^ (Math.random()*1e9|0)) >>> 0;
document.getElementById('seedLabel').textContent = "seed " + SEED;

const WALL_NONE=0, WALL_BRICK=1, WALL_CONCRETE=2, WALL_GLASS=3;
const FLOOR_SIDEWALK=1, FLOOR_ROAD=2, FLOOR_PARK=3, FLOOR_CROSS_V=4, FLOOR_CROSS_H=5;

const world = {
  width:0, height:0,
  walls: [], floors: [],
  tags: [], decals: [],
  textures: {}, sprites:{},
  spawn:{x:2.5,y:2.5}
};

const player = { x:2.5, y:2.5, dir:0, hp:100, spray:100 };

const civilians = [];
const cops = [];
const cars = [];

/* ========= Input ========= */
const keys = Object.create(null);
let mouseDown = false;
addEventListener('keydown', e=>{ keys[e.code]=true; if(e.code==='KeyH'){ const d=document.getElementById('help'); d.open=!d.open; } if(e.code==='KeyP'){ paused=!paused; }});
addEventListener('keyup', e=>{ keys[e.code]=false; });
view.addEventListener('mousedown', e=>{ if(e.button===0) mouseDown = true; });
addEventListener('mouseup', e=>{ if(e.button===0) mouseDown = false; });

/* ========= Textures ========= */
function createBrickTexture(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#7d1d1d'; g.fillRect(0,0,size,size);
  const h=size/8,w=size/4;
  for(let y=0;y<size;y+=h){
    for(let x=0;x<size;x+=w){
      const off=((y/h)|0)%2?w/2:0;
      g.fillStyle=`rgb(${120+randi(-15,15)},${30+randi(-10,10)},${30+randi(-10,10)})`;
      g.fillRect((x+off)%size+1,y+1,w-2,h-2);
    }
  }
  g.fillStyle='rgba(0,0,0,.35)'; for(let y=0;y<size;y+=h) g.fillRect(0,y,size,1);
  for(let row=0;row<size/h;row++){ const off=row%2?w/2:0; for(let x=off;x<size+off;x+=w) g.fillRect((x%size)|0,row*h,1,h); }
  return c;
}
function createConcreteTexture(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#cfcfcf'; g.fillRect(0,0,size,size);
  for(let i=0;i<800;i++){ g.fillStyle=`rgba(0,0,0,${(Math.random()*0.12).toFixed(3)})`; g.fillRect(randi(0,size-1),randi(0,size-1),1,1); }
  for(let y=0;y<size;y++){ g.fillStyle=`rgba(0,0,0,${(0.05*Math.sin(y/7)+0.06).toFixed(3)})`; g.fillRect(0,y,size,1); }
  return c;
}
function createGlassTexture(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  const base=g.createLinearGradient(0,0,0,size); base.addColorStop(0,'#a8e6ff'); base.addColorStop(1,'#5bb3e6');
  g.fillStyle=base; g.fillRect(0,0,size,size);
  g.fillStyle='rgba(255,255,255,.25)'; for(let y=0;y<size;y+=8) g.fillRect(0,y,size,2);
  g.fillStyle='rgba(0,0,0,.12)'; for(let y=4;y<size;y+=8) g.fillRect(0,y,size,1);
  return c;
}
/* asphalt without lane dashes */
function createAsphaltTexture(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#2b2b2f'; g.fillRect(0,0,size,size);
  for(let i=0;i<1500;i++){ g.fillStyle=`rgba(255,255,255,${(Math.random()*0.06).toFixed(3)})`; g.fillRect(randi(0,size-1),randi(0,size-1),1,1); }
  return c;
}
function createSidewalkTexture(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#bfc5c9'; g.fillRect(0,0,size,size);
  g.strokeStyle='rgba(0,0,0,.25)'; g.lineWidth=1;
  for(let x=0;x<size;x+=8){ g.beginPath(); g.moveTo(x,0); g.lineTo(x,size); g.stroke(); }
  for(let y=0;y<size;y+=8){ g.beginPath(); g.moveTo(0,y); g.lineTo(size,y); g.stroke(); }
  for(let i=0;i<800;i++){ g.fillStyle=`rgba(0,0,0,${(Math.random()*0.12).toFixed(3)})`; g.fillRect(randi(0,size-1),randi(0,size-1),1,1); }
  return c;
}
function createParkTexture(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#2f6d2f'; g.fillRect(0,0,size,size);
  for(let i=0;i<1000;i++){ g.fillStyle=`rgba(255,255,255,${(Math.random()*0.08).toFixed(3)})`; g.fillRect(randi(0,size-1),randi(0,size-1),1,1); }
  return c;
}
function createSprayTexture(size=96){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  const grad=g.createRadialGradient(size/2,size/2,2,size/2,size/2,size/2);
  grad.addColorStop(0,'rgba(255,255,255,.35)'); grad.addColorStop(1,'rgba(255,255,255,0)');
  g.fillStyle=grad; g.fillRect(0,0,size,size); return c;
}
function createTagTexture(text='NY90', w=48,h=32){
  const c=document.createElement('canvas'); c.width=w; c.height=h; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='rgba(0,0,0,0)'; g.fillRect(0,0,w,h);
  for(let i=0;i<3;i++){ g.font=`bold ${16+i}px Arial`; g.fillStyle=['#ff3bd4','#39ff14','#20d0ff'][i%3]; g.translate(1,0); g.fillText(text, 4+i, 20+i); }
  g.setTransform(1,0,0,1,0,0); return c;
}
/* Crosswalk textures */
function createCrosswalkTextureV(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#2b2b2f'; g.fillRect(0,0,size,size);
  g.fillStyle='#ffffff'; for(let x=2; x<size; x+=12){ g.fillRect(x, 0, 6, size); }
  g.globalAlpha=0.12; g.fillStyle='#000'; g.fillRect(0,0,size,size); g.globalAlpha=1;
  return c;
}
function createCrosswalkTextureH(size=64){
  const c=document.createElement('canvas'); c.width=c.height=size; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#2b2b2f'; g.fillRect(0,0,size,size);
  g.fillStyle='#ffffff'; for(let y=2; y<size; y+=12){ g.fillRect(0, y, size, 6); }
  g.globalAlpha=0.12; g.fillStyle='#000'; g.fillRect(0,0,size,size); g.globalAlpha=1;
  return c;
}

/* ========= Sprites 16×16 ========= */
function createPoliceSprite(){
  const c=document.createElement('canvas'); c.width=c.height=16; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.clearRect(0,0,16,16); g.fillStyle='#0b1a5e'; g.fillRect(4,6,8,8);
  g.fillStyle='#f1d2b3'; g.fillRect(6,3,4,3);
  g.fillStyle='#fff'; g.fillRect(5,1,6,2);
  g.fillStyle='#ffd400'; g.fillRect(10,9,2,2);
  g.fillStyle='#09144a'; g.fillRect(5,14,2,2); g.fillRect(9,14,2,2);
  return c;
}
function createCivilianSprite(){
  const c=document.createElement('canvas'); c.width=c.height=16; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  const shirt=`hsl(${randi(0,360)},70%,60%)`, pants=`hsl(${randi(0,360)},40%,40%)`;
  g.clearRect(0,0,16,16); g.fillStyle='#f1d8b5'; g.fillRect(6,3,4,3);
  g.fillStyle=shirt; g.fillRect(4,6,8,6);
  g.fillStyle=pants; g.fillRect(5,12,6,3); return c;
}
/* cars front/back */
function createCarFront(color){
  const c=document.createElement('canvas'); c.width=c.height=16; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle=color; g.fillRect(2,4,12,8);
  g.fillStyle='#aee7ff'; g.fillRect(4,1,8,3);
  g.fillStyle='#ffff99'; g.fillRect(1,6,2,2); g.fillRect(13,6,2,2);
  g.fillStyle='#000'; g.fillRect(2,12,12,2);
  return c;
}
function createCarBack(color){
  const c=document.createElement('canvas'); c.width=c.height=16; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle=color; g.fillRect(2,4,12,8);
  g.fillStyle='#aee7ff'; g.fillRect(4,12,8,3);
  g.fillStyle='#ff3333'; g.fillRect(1,8,2,3); g.fillRect(13,8,2,3);
  g.fillStyle='#000'; g.fillRect(2,4,12,2);
  return c;
}
function createPoliceCarFront(phase=false){
  const c=document.createElement('canvas'); c.width=c.height=16; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#1b2b8d'; g.fillRect(2,4,12,8);
  g.fillStyle='#fff'; g.fillRect(2,8,12,2);
  g.fillStyle=phase?'#ff3344':'#3aa0ff'; g.fillRect(4,1,3,3);
  g.fillStyle=phase?'#3aa0ff':'#ff3344'; g.fillRect(9,1,3,3);
  g.fillStyle='#ffff99'; g.fillRect(1,6,2,2); g.fillRect(13,6,2,2);
  return c;
}
function createPoliceCarBack(){
  const c=document.createElement('canvas'); c.width=c.height=16; const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.fillStyle='#1b2b8d'; g.fillRect(2,4,12,8);
  g.fillStyle='#fff'; g.fillRect(2,6,12,2);
  g.fillStyle='#ff3333'; g.fillRect(3,11,3,2); g.fillRect(10,11,3,2);
  g.fillStyle='#aee7ff'; g.fillRect(4,12,8,3);
  return c;
}

/* ========= City generation ========= */
/**
 * generateCityMap — siatka bloków, ulice 4× szersze od chodników; losowe parki;
 * tagi na obwodzie budynków; przejścia dla pieszych dodawane RZADKO i tylko
 * przy wybranych skrzyżowaniach (probabilistycznie), w małych "ramionach".
 */
function generateCityMap(blocksX=7, blocksY=6){
  const sidewalkW=1, roadW=4, buildingW=6;
  const mapW = roadW + blocksX*(sidewalkW*2 + buildingW) + (blocksX-1)*roadW + roadW;
  const mapH = roadW + blocksY*(sidewalkW*2 + buildingW) + (blocksY-1)*roadW + roadW;
  const walls = Array.from({length:mapH},()=>new Int8Array(mapW));
  const floors = Array.from({length:mapH},()=>new Int8Array(mapW));
  const tags = [];

  function fillRect(ax,ay,w,h, fn){
    for(let y=ay;y<ay+h;y++){ if(y<0||y>=mapH) continue;
      for(let x=ax;x<ax+w;x++){ if(x<0||x>=mapW) continue; fn(x,y); }
    }
  }
  // default: road
  for(let y=0;y<mapH;y++) for(let x=0;x<mapW;x++) floors[y][x]=FLOOR_ROAD;

  let yCursor = roadW;
  for(let by=0; by<blocksY; by++){
    // top sidewalk
    fillRect(0, yCursor, mapW, sidewalkW, (x,y)=>{ floors[y][x]=FLOOR_SIDEWALK; });
    yCursor += sidewalkW;

    let xCursor = roadW;
    for(let bx=0; bx<blocksX; bx++){
      // left sidewalk
      fillRect(xCursor, yCursor, sidewalkW, buildingW, (x,y)=>{ floors[y][x]=FLOOR_SIDEWALK; });
      xCursor += sidewalkW;

      // building or park
      const isPark = RNG() < 0.16;
      const mat = [WALL_BRICK,WALL_CONCRETE,WALL_GLASS][randi(0,2)];
      if(isPark){
        fillRect(xCursor, yCursor, buildingW, buildingW, (x,y)=>{ floors[y][x]=FLOOR_PARK; walls[y][x]=WALL_NONE; });
      }else{
        fillRect(xCursor, yCursor, buildingW, buildingW, (x,y)=>{ floors[y][x]=FLOOR_SIDEWALK; walls[y][x]=mat; });
        // tags around edges
        for(let tx=0; tx<buildingW; tx+=Math.max(2, (2 + (RNG()*3|0)))) if(inBounds(floors, xCursor+tx, yCursor-1)) tags.push({x:xCursor+tx+0.5, y:yCursor-0.1, face:'N', done:false, color:`hsl(${randi(0,360)},80%,60%)`});
        for(let tx=1; tx<buildingW; tx+=Math.max(2, (2 + (RNG()*3|0)))) if(inBounds(floors, xCursor+tx, yCursor+buildingW)) tags.push({x:xCursor+tx+0.5, y:yCursor+buildingW+0.1, face:'S', done:false, color:`hsl(${randi(0,360)},80%,60%)`});
        for(let ty=1; ty<buildingW; ty+=Math.max(2, (2 + (RNG()*3|0)))) if(inBounds(floors, xCursor-1, yCursor+ty)) tags.push({x:xCursor-0.1, y:yCursor+ty+0.5, face:'W', done:false, color:`hsl(${randi(0,360)},80%,60%)`});
        for(let ty=0; ty<buildingW; ty+=Math.max(2, (2 + (RNG()*3|0)))) if(inBounds(floors, xCursor+buildingW, yCursor+ty)) tags.push({x:xCursor+buildingW+0.1, y:yCursor+ty+0.5, face:'E', done:false, color:`hsl(${randi(0,360)},80%,60%)`});
      }

      xCursor += buildingW;
      // right sidewalk
      fillRect(xCursor, yCursor, sidewalkW, buildingW, (x,y)=>{ floors[y][x]=FLOOR_SIDEWALK; });
      xCursor += sidewalkW;

      // vertical road between blocks
      if(bx < blocksX-1){
        fillRect(xCursor, yCursor-sidewalkW, roadW, buildingW+2*sidewalkW, (x,y)=>{ floors[y][x]=FLOOR_ROAD; walls[y][x]=WALL_NONE; });
        xCursor += roadW;
      }
    }

    // bottom sidewalk
    fillRect(0, yCursor+buildingW, mapW, sidewalkW, (x,y)=>{ floors[y][x]=FLOOR_SIDEWALK; });
    yCursor += buildingW + sidewalkW;

    // horizontal road between block rows
    if(by < blocksY-1){
      fillRect(0, yCursor, mapW, roadW, (x,y)=>{ floors[y][x]=FLOOR_ROAD; walls[y][x]=WALL_NONE; });
      yCursor += roadW;
    }
  }
  // outer belt roads thicken
  for(let y=0;y<mapH;y++){ for(let x=0;x<4;x++){ floors[y][x]=FLOOR_ROAD; floors[y][mapW-1-x]=FLOOR_ROAD; } }

  /* ---- Crosswalks: choose RARE intersections only, then paint tiny bands ----
     Heurystyka:
      - komórka jest skrzyżowaniem jeśli N/S/E/W to ROAD
      - losowość: tylko ~8% takich komórek
      - dodatkowo anti-cluster: jeśli w promieniu 3 już jest crosswalk, pomiń
      - malujemy mały plusik: H i V po 3×3 kafle — nie rozlewa się po ulicach
  */
  function areaHasCrosswalk(cx,cy){
    for(let yy=cy-3; yy<=cy+3; yy++)
      for(let xx=cx-3; xx<=cx+3; xx++)
        if(inBounds(floors,xx,yy) && (floors[yy][xx]===FLOOR_CROSS_H || floors[yy][xx]===FLOOR_CROSS_V)) return true;
    return false;
  }
  for(let y=2;y<mapH-2;y++){
    for(let x=2;x<mapW-2;x++){
      if(floors[y][x]!==FLOOR_ROAD) continue;
      if(!(floors[y-1][x]===FLOOR_ROAD && floors[y+1][x]===FLOOR_ROAD && floors[y][x-1]===FLOOR_ROAD && floors[y][x+1]===FLOOR_ROAD)) continue;
      if(RNG() > 0.08) continue;               // rzadko
      if(areaHasCrosswalk(x,y)) continue;      // anti-cluster

      // poziome ramię (3x3 w poziomie)
      for(let dx=-1; dx<=1; dx++)
        for(let t=-1; t<=1; t++){
          const xx=x+dx, yy=y+t;
          if(inBounds(floors,xx,yy) && floors[yy][xx]===FLOOR_ROAD) floors[yy][xx]=FLOOR_CROSS_H;
        }
      // pionowe ramię (3x3 w pionie)
      for(let dy=-1; dy<=1; dy++)
        for(let t=-1; t<=1; t++){
          const xx=x+t, yy=y+dy;
          if(inBounds(floors,xx,yy) && floors[yy][xx]===FLOOR_ROAD) floors[yy][xx]=FLOOR_CROSS_V;
        }
    }
  }

  // spawn on sidewalk
  let sx=2, sy=2, safety=5000;
  while(safety-->0){
    sx = randi(4, mapW-5); sy = randi(4, mapH-5);
    if(inBounds(walls,sx,sy) && walls[sy][sx]===WALL_NONE && floors[sy][sx]===FLOOR_SIDEWALK) break;
  }
  return {width:mapW, height:mapH, walls, floors, tags, spawn:{x:sx+0.5,y:sy+0.5}};
}

/* ========= Raycasting ========= */
function castRay(px,py, angle){
  const mapW=world.width, mapH=world.height;
  let rayDirX=Math.cos(angle), rayDirY=Math.sin(angle);
  let mapX=px|0, mapY=py|0;
  let sideDistX, sideDistY;
  const deltaDistX=Math.abs(1/(rayDirX||1e-9));
  const deltaDistY=Math.abs(1/(rayDirY||1e-9));
  let stepX, stepY;

  if(rayDirX<0){ stepX=-1; sideDistX=(px-mapX)*deltaDistX; } else { stepX=1; sideDistX=(mapX+1-px)*deltaDistX; }
  if(rayDirY<0){ stepY=-1; sideDistY=(py-mapY)*deltaDistY; } else { stepY=1; sideDistY=(mapY+1-py)*deltaDistY; }

  let hit=false, side=0, type=WALL_NONE, guard=0;
  while(!hit && guard++<2048){
    if(sideDistX<sideDistY){ sideDistX+=deltaDistX; mapX+=stepX; side=0; }
    else { sideDistY+=deltaDistY; mapY+=stepY; side=1; }
    if(mapX<0||mapY<0||mapX>=mapW||mapY>=mapH){ hit=true; type=WALL_BRICK; break; }
    type = world.walls[mapY][mapX];
    if(type!==WALL_NONE) hit=true;
  }
  let perpWallDist = side===0 ? (mapX - px + (1 - stepX)/2) / (rayDirX||1e-9)
                              : (mapY - py + (1 - stepY)/2) / (rayDirY||1e-9);
  perpWallDist = Math.max(0.0001, perpWallDist);
  let wallX = (side===0)? (py + perpWallDist*rayDirY) : (px + perpWallDist*rayDirX);
  wallX -= Math.floor(wallX);
  let texX = (wallX*64)|0;
  if(side===0 && rayDirX>0) texX = 63-texX;
  if(side===1 && rayDirY<0) texX = 63-texX;
  return {dist:perpWallDist, side, texX, type};
}

/* ========= Floor casting (aligned) ========= */
let zBuffer = new Float32Array(W);
function drawFloor(){
  const texAsphalt=world.textures.asphalt, texSide=world.textures.sidewalk, texPark=world.textures.park;
  const texCrossV=world.textures.crossV, texCrossH=world.textures.crossH;

  // sky
  ctx.fillStyle = '#0a0f16';
  ctx.fillRect(0,0,W,HALF_H);

  const dirX=Math.cos(player.dir), dirY=Math.sin(player.dir);
  const planeX=Math.cos(player.dir + Math.PI/2) * Math.tan(FOV/2);
  const planeY=Math.sin(player.dir + Math.PI/2) * Math.tan(FOV/2);

  const rayDirX0 = dirX - planeX, rayDirY0 = dirY - planeY;
  const rayDirX1 = dirX + planeX, rayDirY1 = dirY + planeY;

  const posX=player.x, posY=player.y, texSize=64;
  const posZ = 0.5 * H;

  for(let y=HALF_H; y<H; y++){
    const p = (y - HALF_H) || 1;
    const rowDist = posZ / p;

    const stepX = rowDist * (rayDirX1 - rayDirX0) / W;
    const stepY = rowDist * (rayDirY1 - rayDirY0) / W;

    let floorX = posX + rowDist * rayDirX0;
    let floorY = posY + rowDist * rayDirY0;

    for(let x=0; x<W; x++){
      const cellX=floorX|0, cellY=floorY|0;
      const ft = (world.floors[cellY] && world.floors[cellY][cellX]) || FLOOR_ROAD;

      let src = texAsphalt;
      if(ft===FLOOR_SIDEWALK) src = texSide;
      else if(ft===FLOOR_PARK) src = texPark;
      else if(ft===FLOOR_CROSS_V) src = texCrossV;
      else if(ft===FLOOR_CROSS_H) src = texCrossH;

      let tx = ((floorX - Math.floor(floorX)) * texSize) | 0;
      let ty = ((floorY - Math.floor(floorY)) * texSize) | 0;

      try{ ctx.drawImage(src, tx, ty, 1,1, x,y, 1,1); }catch(_){}

      floorX += stepX; floorY += stepY;
    }
    const shade = clamp((y - HALF_H) / (H*0.9),0,0.6);
    if(shade>0){ ctx.globalAlpha=shade; ctx.fillStyle='#000'; ctx.fillRect(0,y,W,1); ctx.globalAlpha=1; }
  }
}

/* ========= World render ========= */
function render3D(){
  drawFloor();

  const dirX=Math.cos(player.dir), dirY=Math.sin(player.dir);
  const planeX=Math.cos(player.dir + Math.PI/2) * Math.tan(FOV/2);
  const planeY=Math.sin(player.dir + Math.PI/2) * Math.tan(FOV/2);

  const texBrick=world.textures.brick, texConc=world.textures.concrete, texGlass=world.textures.glass;

  for(let x=0;x<W;x++){
    const cameraX = 2 * x / W - 1;
    const rayDirX = dirX + planeX * cameraX;
    const rayDirY = dirY + planeY * cameraX;
    const a = Math.atan2(rayDirY, rayDirX);
    const hit = castRay(player.x, player.y, a);

    const perpDist = hit.dist;
    zBuffer[x] = perpDist;

    let lineH = (H / perpDist)|0;
    let drawStart = -lineH/2 + HALF_H; if(drawStart<0) drawStart=0;
    let drawEnd   =  lineH/2 + HALF_H; if(drawEnd>=H) drawEnd=H-1;

    const texX = clamp(hit.texX|0,0,63);
    let src = texBrick; if(hit.type===WALL_CONCRETE) src=texConc; else if(hit.type===WALL_GLASS) src=texGlass;
    try{ ctx.drawImage(src, texX, 0, 1, 64, x, drawStart, 1, drawEnd-drawStart); }catch(_){}

    const shade = clamp(perpDist/14,0,0.7) + (hit.side?0.06:0);
    if(shade>0){ ctx.globalAlpha=shade; ctx.fillStyle='#000'; ctx.fillRect(x, drawStart, 1, drawEnd-drawStart); ctx.globalAlpha=1; }
  }
}

/* ========= Sprites & overlays ========= */
function renderSprites(){
  const all=[];
  for(const p of civilians) all.push({x:p.x,y:p.y,img:p.sprite,size:0.65,dist:dist2(player.x,player.y,p.x,p.y),shade:(p.stunT>0?0.4:0)});
  for(const p of cops) all.push({x:p.x,y:p.y,img:world.sprites.police,size:0.85,dist:dist2(player.x,player.y,p.x,p.y),shade:(p.state==='stunned'?0.5:0)});
  // cars choose front/back depending on approaching the player
  for(const c of cars){
    const toPlayerX = player.x - c.x, toPlayerY = player.y - c.y;
    const carDirX = Math.cos(c.dir), carDirY = Math.sin(c.dir);
    const dot = carDirX*toPlayerX + carDirY*toPlayerY; // >0 → heading toward us
    let img;
    if(c.type==='police'){
      img = (dot>0) ? ((Math.sin(c.flashPhase)>0)?world.sprites.pcarFrontOn:world.sprites.pcarFrontOff)
                    : world.sprites.pcarBack;
    }else{
      img = (dot>0) ? c.spriteFront : c.spriteBack;
    }
    all.push({x:c.x,y:c.y,img,size:1.2,dist:dist2(player.x,player.y,c.x,c.y),shade:0});
  }
  for(const d of world.decals) all.push({x:d.x,y:d.y,img:d.img,size:0.8,dist:dist2(player.x,player.y,d.x,d.y),shade:0.2});
  all.sort((a,b)=>b.dist-a.dist);

  const dirX=Math.cos(player.dir), dirY=Math.sin(player.dir);
  const planeX=Math.cos(player.dir + Math.PI/2) * Math.tan(FOV/2);
  const planeY=Math.sin(player.dir + Math.PI/2) * Math.tan(FOV/2);
  const invDet = 1.0 / (planeX*dirY - dirX*planeY + 1e-9);

  for(const s of all){
    const spriteX = s.x - player.x, spriteY = s.y - player.y;
    const transformX = invDet * (dirY * spriteX - dirX * spriteY);
    const transformY = invDet * (-planeY * spriteX + planeX * spriteY);
    if(transformY <= 0.01) continue;

    const screenX = (W/2) * (1 + transformX/transformY);
    const spriteH = Math.abs((H / transformY) * s.size)|0;
    const drawStartY = clamp((-spriteH/2 + HALF_H)|0, 0, H-1);
    const drawEndY   = clamp(( spriteH/2 + HALF_H)|0, 0, H-1);
    const spriteW = spriteH;
    const drawStartX = clamp((-spriteW/2 + screenX)|0, 0, W-1);
    const drawEndX   = clamp(( spriteW/2 + screenX)|0, 0, W-1);

    for(let stripe=drawStartX; stripe<drawEndX; stripe++){
      const texX = Math.floor((stripe - (-spriteW/2 + screenX)) * 16 / spriteW);
      if(transformY>0 && stripe>0 && stripe<W && transformY < zBuffer[stripe]){
        try{
          ctx.drawImage(s.img, texX, 0, 1, 16, stripe, drawStartY, 1, drawEndY-drawStartY);
          if(s.shade>0){ ctx.globalAlpha=s.shade; ctx.fillStyle='#000'; ctx.fillRect(stripe,drawStartY,1,drawEndY-drawStartY); ctx.globalAlpha=1; }
        }catch(_){}
      }
    }
  }
}
function renderSprayOverlay(amount=1){
  ctx.globalAlpha = 0.25 * amount;
  const spr=world.textures.spray; const size=Math.min(W,H)*0.8;
  ctx.drawImage(spr, 0,0,spr.width,spr.height, HALF_W-size/2, HALF_H-size/3, size, size);
  ctx.globalAlpha = 1;
}

/* ========= Minimapa ========= */
function renderMinimap(){
  const mw=world.width, mh=world.height;
  const sx=minimap.width/mw, sy=minimap.height/mh;
  mctx.clearRect(0,0,minimap.width,minimap.height);
  mctx.fillStyle='#061019'; mctx.fillRect(0,0,minimap.width,minimap.height);
  for(let y=0;y<mh;y++) for(let x=0;x<mw;x++){
    const fx=(x*sx)|0, fy=(y*sy)|0;
    const f=world.floors[y][x];
    if(f===FLOOR_ROAD) mctx.fillStyle='#1b1f24';
    else if(f===FLOOR_SIDEWALK) mctx.fillStyle='#b6c1c7';
    else if(f===FLOOR_PARK) mctx.fillStyle='#1f4d1f';
    else mctx.fillStyle='#f6f6f6';
    mctx.fillRect(fx,fy, Math.ceil(sx), Math.ceil(sy));
    if(world.walls[y][x]!==WALL_NONE){ mctx.fillStyle='#aa3333'; mctx.fillRect(fx,fy, Math.ceil(sx), Math.ceil(sy)); }
  }
  for(const t of world.tags){ mctx.fillStyle = t.done?'#39ff14':'#ffcc00'; mctx.fillRect((t.x*sx)|0-1,(t.y*sy)|0-1,3,3); }
  function dot(x,y,col){ mctx.fillStyle=col; mctx.fillRect((x*sx)|0-1,(y*sy)|0-1,3,3); }
  for(const c of civilians) dot(c.x,c.y,'#ffffff');
  for(const c of cops) dot(c.x,c.y,'#2d3cff');
  for(const c of cars) dot(c.x,c.y, c.type==='police'?'#2d3cff':'#ff66aa');
  mctx.fillStyle='#39ff14'; mctx.beginPath(); const px=player.x*sx, py=player.y*sy; mctx.arc(px,py,3,0,Math.PI*2); mctx.fill();
  mctx.strokeStyle='#39ff14'; mctx.beginPath(); mctx.moveTo(px,py); mctx.lineTo(px+Math.cos(player.dir)*8, py+Math.sin(player.dir)*8); mctx.stroke();
}

/* ========= Mechanics & AI ========= */
function isBlocked(nx,ny, radius=PLAYER_RADIUS, ignore=null){
  const ix=nx|0, iy=ny|0;
  if(ix<0||iy<0||ix>=world.width||iy>=world.height) return true;
  for(let y=iy-1;y<=iy+1;y++) for(let x=ix-1;x<=ix+1;x++){
    if(!inBounds(world.walls,x,y)) continue;
    if(world.walls[y][x]!==WALL_NONE){
      const cx=x+0.5, cy=y+0.5;
      if(Math.abs(nx-cx)<0.5+radius && Math.abs(ny-cy)<0.5+radius) return true;
    }
  }
  for(const c of cars){ if(ignore===c) continue; if(dist2(nx,ny,c.x,c.y)<(radius+CAR_RADIUS)**2) return true; }
  for(const e of cops){ if(ignore===e) continue; if(dist2(nx,ny,e.x,e.y)<(radius+NPC_RADIUS)**2) return true; }
  for(const e of civilians){ if(ignore===e) continue; if(dist2(nx,ny,e.x,e.y)<(radius+NPC_RADIUS)**2) return true; }
  return false;
}
function tryTag(){
  for(const t of world.tags){
    if(t.done) continue;
    const d2 = dist2(player.x,player.y,t.x,t.y);
    if(d2 < 1.0){
      const ang=Math.atan2(t.y-player.y, t.x-player.x);
      const diff=Math.atan2(Math.sin(ang-player.dir), Math.cos(ang-player.dir));
      if(Math.abs(diff) < Math.PI/4){
        t.done=true;
        let dx=0,dy=0; if(t.face==='N') dy=-0.12; else if(t.face==='S') dy=0.12; else if(t.face==='W') dx=-0.12; else dx=0.12;
        world.decals.push({x:t.x+dx, y:t.y+dy, img:(RNG()<0.5?world.textures.tagA:world.textures.tagB)});
        player.spray = clamp(player.spray+2, 0, 100);
        break;
      }
    }
  }
  const done=world.tags.filter(t=>t.done).length;
  if(done>=world.tags.length && world.tags.length>0){ document.getElementById('win').classList.add('show'); paused=true; }
}
function fireSpray(dt){
  if(player.spray<=0) return;
  player.spray = clamp(player.spray - 20*dt, 0, 100);
  function affect(list){
    for(const e of list){
      const dx=e.x-player.x, dy=e.y-player.y; const d=Math.hypot(dx,dy);
      if(d>SPRAY_RANGE) continue;
      const ang=Math.atan2(dy,dx);
      const diff=Math.atan2(Math.sin(ang-player.dir), Math.cos(ang-player.dir));
      if(Math.abs(diff)>SPRAY_ANGLE) continue;
      const hit = castRay(player.x,player.y,ang);
      if(hit.dist > d-0.1){
        if(e.state!==undefined){ e.state='stunned'; e.stunT=STUN_TIME; } else e.stunT=STUN_TIME;
      }
    }
  }
  affect(civilians); affect(cops);
}
function updateCivilianAI(dt){
  for(const c of civilians){
    if(c.stunT>0){ c.stunT-=dt; continue; }
    if(RNG()<0.02) c.dir += (RNG()-0.5)*1.2;
    const speed=1.2;
    let nx=c.x + Math.cos(c.dir)*speed*dt;
    let ny=c.y + Math.sin(c.dir)*speed*dt;
    const fx=nx|0, fy=ny|0;
    if(!inBounds(world.floors,fx,fy) || world.floors[fy][fx]!==FLOOR_SIDEWALK || isBlocked(nx,ny,NPC_RADIUS,c)){
      c.dir += (Math.PI/2) * (RNG()<0.5?-1:1); continue;
    }
    c.x=nx; c.y=ny;
  }
}
function updatePoliceAI(dt){
  for(const p of cops){
    if(p.state==='stunned'){ p.stunT-=dt; if(p.stunT<=0){ p.state='patrol'; p.stunT=0; } continue; }
    const dx=player.x-p.x, dy=player.y-p.y; const d=Math.hypot(dx,dy);
    if(d<6){ const ang=Math.atan2(dy,dx); const hit=castRay(p.x,p.y,ang); if(hit.dist>d-0.1){ p.state='chase'; } }
    if(p.state==='chase'){
      p.dir = Math.atan2(player.y-p.y, player.x-p.x);
      const speed=1.5;
      let nx=p.x + Math.cos(p.dir)*speed*dt;
      let ny=p.y + Math.sin(p.dir)*speed*dt;
      const fx=nx|0, fy=ny|0;
      if(!inBounds(world.floors,fx,fy) || world.floors[fy][fx]===FLOOR_PARK || world.walls[fy][fx]!==WALL_NONE || isBlocked(nx,ny,NPC_RADIUS,p)){
        p.dir += (Math.random()<0.5?1:-1)*0.6; continue;
      }
      p.x=nx; p.y=ny;
      if(dist2(p.x,p.y,player.x,player.y) < (NPC_RADIUS+PLAYER_RADIUS)**2){
        player.hp = clamp(player.hp - DAMAGE_FROM_COP_TOUCH*dt, 0, 100);
        if(player.hp<=0){ document.getElementById('lose').classList.add('show'); paused=true; }
      }
    }else{
      if(RNG()<0.02) p.dir += (RNG()-0.5)*1.2;
      const speed=1.35;
      let nx=p.x + Math.cos(p.dir)*speed*dt;
      let ny=p.y + Math.sin(p.dir)*speed*dt;
      const fx=nx|0, fy=ny|0;
      if(!inBounds(world.floors,fx,fy) || world.floors[fy][fx]!==FLOOR_SIDEWALK || isBlocked(nx,ny,NPC_RADIUS,p)){
        p.dir += (Math.PI/2) * (RNG()<0.5?-1:1); continue;
      }
      p.x=nx; p.y=ny;
    }
  }
}
function updateVehicleAI(dt){
  for(const v of cars){
    const speed=v.speed;
    let nx=v.x + Math.cos(v.dir)*speed*dt;
    let ny=v.y + Math.sin(v.dir)*speed*dt;
    const fx=nx|0, fy=ny|0;
    if(!inBounds(world.floors,fx,fy) || (world.floors[fy][fx]!==FLOOR_ROAD && world.floors[fy][fx]!==FLOOR_CROSS_H && world.floors[fy][fx]!==FLOOR_CROSS_V) || isBlocked(nx,ny,CAR_RADIUS,v)){
      const choices=[];
      const left=v.dir - Math.PI/2, right=v.dir + Math.PI/2;
      function canDir(dir){
        const tx = v.x + Math.cos(dir)*0.8, ty = v.y + Math.sin(dir)*0.8;
        const ix=tx|0, iy=ty|0;
        return inBounds(world.floors,ix,iy) && (world.floors[iy][ix]===FLOOR_ROAD || world.floors[iy][ix]===FLOOR_CROSS_H || world.floors[iy][ix]===FLOOR_CROSS_V);
      }
      if(canDir(left)) choices.push(left);
      if(canDir(right)) choices.push(right);
      if(choices.length>0) v.dir = choices[randi(0,choices.length-1)];
      else v.dir += Math.PI;
      continue;
    }
    v.x=nx; v.y=ny;
    if(v.type==='police') v.flashPhase += dt*6;
    if(dist2(v.x,v.y,player.x,player.y) < (CAR_RADIUS+PLAYER_RADIUS)**2){
      player.hp = clamp(player.hp - DAMAGE_FROM_CAR*dt, 0, 100);
      if(player.hp<=0){ document.getElementById('lose').classList.add('show'); paused=true; }
    }
  }
}

/* ========= Player ========= */
function updatePlayer(dt){
  let forward=(keys['KeyW']?1:0) + (keys['KeyS']?-1:0);
  let strafe=(keys['KeyD']?1:0) + (keys['KeyA']?-1:0);
  let rot=(keys['KeyE']?1:0) + (keys['KeyQ']?-1:0);
  player.dir += rot * ROT_SPEED * dt;
  const fdx=Math.cos(player.dir), fdy=Math.sin(player.dir);
  const rdx=Math.cos(player.dir+Math.PI/2), rdy=Math.sin(player.dir+Math.PI/2);
  const onRoad = (world.floors[player.y|0] && ([FLOOR_ROAD,FLOOR_CROSS_H,FLOOR_CROSS_V].includes(world.floors[player.y|0][player.x|0])));
  const speedMul = onRoad ? ROAD_SPEED_MULT : 1.0;
  let nx=player.x + (fdx*forward*MOVE_SPEED + rdx*strafe*STRAFE_SPEED) * dt * speedMul;
  let ny=player.y + (fdy*forward*MOVE_SPEED + rdy*strafe*STRAFE_SPEED) * dt * speedMul;
  if(!isBlocked(nx,player.y)) player.x=nx;
  if(!isBlocked(player.x,ny)) player.y=ny;

  if(keys['Space']||mouseDown){ fireSpray(dt); renderSprayOverlay(); }
  if(keys['KeyE']){ tryTag(); }
}

/* ========= HUD ========= */
function updateHUD(){
  const hp=clamp(player.hp,0,100)|0, sp=clamp(player.spray,0,100)|0;
  document.getElementById('hpLabel').textContent=hp;
  document.getElementById('sprayLabel').textContent=sp;
  document.getElementById('hpFill').style.width=hp+'%';
  document.getElementById('sprayFill').style.width=sp+'%';
  const done=world.tags.filter(t=>t.done).length;
  document.getElementById('tagDone').textContent=done;
  document.getElementById('tagNeed').textContent=world.tags.length;
}

/* ========= Init ========= */
function buildArt(){
  world.textures.brick=createBrickTexture(64);
  world.textures.concrete=createConcreteTexture(64);
  world.textures.glass=createGlassTexture(64);
  world.textures.asphalt=createAsphaltTexture(64);
  world.textures.sidewalk=createSidewalkTexture(64);
  world.textures.park=createParkTexture(64);
  world.textures.crossV=createCrosswalkTextureV(64);
  world.textures.crossH=createCrosswalkTextureH(64);
  world.textures.spray=createSprayTexture(96);
  world.textures.tagA=createTagTexture('NY90',48,32);
  world.textures.tagB=createTagTexture('DOOM',48,32);

  world.sprites.police=createPoliceSprite();
  world.sprites.pcarFrontOn=createPoliceCarFront(true);
  world.sprites.pcarFrontOff=createPoliceCarFront(false);
  world.sprites.pcarBack=createPoliceCarBack();
}
function spawnEntities(){
  civilians.length=0; cops.length=0; cars.length=0;
  const civN = Math.max(10, Math.min(30, (world.width*world.height/450)|0));
  const copN = Math.max(4, Math.min(12, (world.width*world.height/1200)|0));
  const carN = Math.max(6, Math.min(16, (world.width*world.height/900)|0));
  for(let i=0;i<civN;i++){
    let safe=3000,x=0,y=0; while(safe-->0){ x=randi(0,world.width-1)+0.5; y=randi(0,world.height-1)+0.5;
      if(inBounds(world.floors,x|0,y|0) && world.floors[y|0][x|0]===FLOOR_SIDEWALK && !isBlocked(x,y,NPC_RADIUS,null)) break; }
    civilians.push({x,y,dir:RNG()*Math.PI*2,stunT:0,sprite:createCivilianSprite()});
  }
  for(let i=0;i<copN;i++){
    let safe=3000,x=0,y=0; while(safe-->0){ x=randi(0,world.width-1)+0.5; y=randi(0,world.height-1)+0.5;
      if(inBounds(world.floors,x|0,y|0) && world.floors[y|0][x|0]===FLOOR_SIDEWALK && !isBlocked(x,y,NPC_RADIUS,null)) break; }
    cops.push({x,y,dir:RNG()*Math.PI*2,state:'patrol',stunT:0});
  }
  for(let i=0;i<carN;i++){
    let safe=3000,x=0,y=0; while(safe-->0){ x=randi(0,world.width-1)+0.5; y=randi(0,world.height-1)+0.5;
      const f = inBounds(world.floors,x|0,y|0) ? world.floors[y|0][x|0] : 0;
      if((f===FLOOR_ROAD || f===FLOOR_CROSS_H || f===FLOOR_CROSS_V) && !isBlocked(x,y,CAR_RADIUS,null)) break; }
    const isPolice=RNG()<0.25;
    const dir=[0,Math.PI/2,Math.PI,-Math.PI/2][randi(0,3)];
    if(isPolice){
      cars.push({x,y,dir,speed:2.3,type:'police',flashPhase:RNG()*Math.PI*2});
    }else{
      const color=`hsl(${randi(0,360)},70%,55%)`;
      cars.push({x,y,dir,speed:1.8,type:'civil',
                 spriteFront:createCarFront(color), spriteBack:createCarBack(color)});
    }
  }
}
function init(){
  try{
    RNG = makeRNG(SEED);
    buildArt();
    const city = generateCityMap(randi(6,9), randi(5,7));
    Object.assign(world, {width:city.width, height:city.height, walls:city.walls, floors:city.floors, tags:city.tags, spawn:city.spawn});
    player.x=world.spawn.x; player.y=world.spawn.y; player.dir=RNG()*Math.PI*2; player.hp=100; player.spray=100;
    spawnEntities();
    document.getElementById('tagNeed').textContent=world.tags.length;
  }catch(e){ console.error("Initialization error:", e); alert("Błąd inicjalizacji. Odśwież stronę (F5)."); }
}

/* ========= Loop ========= */
let lastT=performance.now(), fpsAcc=0, fpsCount=0;
function tick(ts){
  const dt = clamp((ts-lastT)/1000, 0, 0.05); lastT=ts;
  if(!paused){
    try{
      updatePlayer(dt);
      updateCivilianAI(dt);
      updatePoliceAI(dt);
      updateVehicleAI(dt);
      render3D();
      renderSprites();
      renderMinimap();
      updateHUD();
    }catch(e){ console.error("Frame error:", e); }
  }
  fpsAcc+=dt; fpsCount++; if(fpsAcc>=0.5){ document.getElementById('fps').textContent=(fpsCount/fpsAcc|0); fpsAcc=0; fpsCount=0; }
  requestAnimationFrame(tick);
}

/* ========= Start ========= */
(function start(){ init(); requestAnimationFrame(tick); })();

/* ========= Safety logs ========= */
addEventListener('error', e=>console.error("Uncaught error:", e.message, e.filename, e.lineno, e.colno));
addEventListener('unhandledrejection', e=>console.error("Unhandled promise rejection:", e.reason));
</script>