// Small, explicit SVG approximations for icons whose AE masks/effects do not port.
// Other icons retain the extracted vectors. This is not a native icon-effect emulator.
const NS='http://www.w3.org/2000/svg';
export const FALLBACK_IDS=new Set(['04','05','07','08','10','11','15','16']);
export function drawMediaFallback(id,parent,size){
  const add=(tag,attrs,into=parent)=>{const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));into.append(n);return n;};
  const g=add('g',{transform:`scale(${size[0]/100} ${size[1]/100})`});
  add('rect',{'data-icon-box':id,width:100,height:100,rx:24,fill:id==='08'?'#d9e4ef':'#24d65b'},g);
  if(id==='08'){
    add('circle',{cx:50,cy:35,r:17,fill:'#7189a2'},g);
    add('path',{d:'M20 84V76C20 48 80 48 80 76V84Z',fill:'#7189a2'},g);
  }else{
    if(id==='02')add('path',{d:'M25 77L28 64A30 30 0 1 1 41 77Z',fill:'none',stroke:'white','stroke-width':5},g);
    add('path',{d:handset,fill:'white',transform:id==='02'?'translate(25 23) scale(2.05)':'translate(14 13) scale(3)'},g);
  }
}
const handset='M6.6 10.8c1.6 3.1 3.5 5 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.2 1.2.4 2.5.7 3.8.7.6 0 1 .4 1 1v3.6c0 .6-.4 1-1 1C10.7 21.3 2.7 13.3 2.7 3.7c0-.6.4-1 1-1h3.6c.6 0 1 .4 1 1 0 1.3.3 2.6.7 3.8.1.4 0 .8-.2 1.1z';
export function drawFallbackIcon(id,parent){
  const add=(tag,attrs,into=parent)=>{const n=document.createElementNS(NS,tag);for(const[k,v]of Object.entries(attrs))n.setAttribute(k,String(v));into.append(n);return n;};
  if(id==='08'){
    for(const [x,y,color,angle]of [[1247.51,539.19,'#ff3c57',135],[1548.49,539.58,'#20d968',0]]){
      add('circle',{cx:x,cy:y,r:112,fill:color,stroke:'#fff','stroke-opacity':.5,'stroke-width':3});
      add('path',{d:handset,fill:'white',transform:`translate(${x} ${y}) rotate(${angle}) scale(5) translate(-12 -12)`});
    }return;
  }
  const clip=add('clipPath',{id:`fallback-clip-${id}`});
  add('rect',{width:100,height:100,rx:24},clip);
  // Find My, Notes and FaceTime use the source's 213.6px slot at y=540.5.
  const size=['11','15','16'].includes(id)?213.6:224;
  const centerY=['11','15','16'].includes(id)?540.5:539;
  const g=add('g',{transform:`translate(${372-size/2} ${centerY-size/2}) scale(${size/100})`,'clip-path':`url(#fallback-clip-${id})`});
  const colors={'04':'#fff','05':'#168cff','07':'#dc3985','10':'#e4efdd','11':'#f2f5fa','15':'#fff','16':'#28d65c'};
  add('rect',{'data-icon-box':id,width:100,height:100,rx:24,fill:colors[id]},g);
  if(id==='04'){
    add('path',{d:'M18 72V29L50 53 82 29V72',fill:'none',stroke:'#4285f4','stroke-width':13,'stroke-linejoin':'round'},g);
    add('path',{d:'M18 29L50 53 82 29',fill:'none',stroke:'#ea4335','stroke-width':13},g);
    add('path',{d:'M82 40V72',stroke:'#34a853','stroke-width':13},g);
    add('path',{d:'M18 40V72',stroke:'#fbbc04','stroke-width':13},g);
  }else if(id==='05'){
    add('rect',{x:14,y:26,width:72,height:49,rx:6,fill:'white'},g);
    add('path',{d:'M16 29L50 53 84 29M16 73L39 51M84 73L61 51',fill:'none',stroke:'#168cff','stroke-width':4},g);
  }else if(id==='07'){
    add('rect',{x:22,y:22,width:56,height:56,rx:17,fill:'none',stroke:'white','stroke-width':7},g);
    add('circle',{cx:50,cy:50,r:14,fill:'none',stroke:'white','stroke-width':7},g);
    add('circle',{cx:68,cy:32,r:4,fill:'white'},g);
  }else if(id==='10'){
    add('path',{d:'M-5 22L105 71M27-5L60 105',stroke:'white','stroke-width':20,fill:'none'},g);
    add('path',{d:'M-5 22L105 71',stroke:'#f6c85d','stroke-width':10,fill:'none'},g);
    add('path',{d:'M27-5L60 105',stroke:'#b7c7d2','stroke-width':3,fill:'none'},g);
    add('circle',{cx:58,cy:49,r:21,fill:'#287eea',stroke:'white','stroke-width':4},g);
    add('path',{d:'M58 34L46 62 58 56 70 62Z',fill:'white'},g);
  }else if(id==='11'){
    add('circle',{cx:50,cy:50,r:38,fill:'#b1e8c2'},g);
    for(const r of [26,14])add('circle',{cx:50,cy:50,r,fill:'none',stroke:'#58cb8e','stroke-width':2},g);
    add('path',{d:'M50 50L81 28A38 38 0 0 0 22 19Z',fill:'#71cd9c','fill-opacity':.6},g);
    add('circle',{cx:50,cy:50,r:7,fill:'#2281ef',stroke:'white','stroke-width':3},g);
  }else if(id==='15'){
    add('path',{d:'M0 24Q0 0 24 0H76Q100 0 100 24V31H0Z',fill:'#ffd754'},g);
    for(const y of [43,57,71,85])add('path',{d:`M12 ${y}H88`,stroke:'#c9ccd0','stroke-width':2},g);
  }else if(id==='16'){
    add('rect',{x:15,y:30,width:46,height:40,rx:9,fill:'white'},g);
    add('path',{d:'M67 41L87 29V71L67 59Z',fill:'white'},g);
  }
}
