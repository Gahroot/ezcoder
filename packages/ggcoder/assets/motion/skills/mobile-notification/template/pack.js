// Project-specific recipes compiled from the existing extraction. No AE code is evaluated.
import { FALLBACK_IDS, drawFallbackIcon, drawMediaFallback } from './icon-fallbacks.js';
const NS = 'http://www.w3.org/2000/svg';
const IDENTITY = [1, 0, 0, 1, 0, 0];
const DEFAULTS = Object.freeze({ view: 'showcase', variant: '01', x: 960, y: 460,
  scale: 0.7, background: 'wallpaper', blur: 8, distortion: 10,
  texts: '{}', media: '{}', visible: '08,03,06' });
const make = (tag, attrs = {}, parent) => {
  const node = document.createElementNS(NS, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  if (parent) parent.append(node);
  return node;
};
const multiply = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1],
  a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3],
  a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const move = (x, y) => [1, 0, 0, 1, x, y];
const zoom = (x, y = x) => [x, 0, 0, y, 0, 0];
const matrixAttr = matrix => `matrix(${matrix.join(' ')})`;
const point = (m, p) => [m[0]*p[0]+m[2]*p[1]+m[4], m[1]*p[0]+m[3]*p[1]+m[5]];
const rgba = value => `rgba(${value.slice(0,3).map(v => Math.round(Math.max(0,Math.min(1,v))*255)).join(',')},${value[3] ?? 1})`;
const bezier = (t, a, b) => 3*(1-t)*(1-t)*t*a + 3*(1-t)*t*t*b + t*t*t;

export function sample(property, time) {
  const keys = property.keys;
  if (!keys.length) return property.value;
  if (time <= keys[0].time) return keys[0].value;
  const last = keys[keys.length-1];
  if (time >= last.time) {
    const dt = time-last.time;
    if (!property.bounce || dt >= 1 || keys.length < 2) return last.value;
    const previous = keys[keys.length-2];
    return last.value.map((v,i) => v + (v-previous.value[i])/(last.time-previous.time)
      * .05*Math.sin(4*Math.PI*dt)/Math.exp(5*dt));
  }
  let end = 1;
  while (time > keys[end].time) end++;
  const a = keys[end-1], b = keys[end], duration = b.time-a.time;
  let ratio = (time-a.time)/duration;
  const kind = a.out_interpolation_type?.name;
  if (kind === 'HOLD') return a.value;
  if (kind === 'BEZIER') {
    const va = Array.isArray(a.value) ? a.value : [a.value];
    const vb = Array.isArray(b.value) ? b.value : [b.value];
    const distance = Math.hypot(...va.map((v,i) => vb[i]-v));
    if (distance > 1e-9) {
      const out = a.out_temporal_ease[0], into = b.in_temporal_ease[0];
      const x1 = Math.min(.999,Math.max(.001,out.influence/100));
      const x2 = 1-Math.min(.999,Math.max(.001,into.influence/100));
      const y1 = Math.abs(out.speed)*duration/distance*x1;
      const y2 = 1-Math.abs(into.speed)*duration/distance*(1-x2);
      let lo=0, hi=1;
      for(let i=0;i<18;i++){const mid=(lo+hi)/2;if(bezier(mid,x1,x2)<ratio)lo=mid;else hi=mid;}
      ratio=bezier((lo+hi)/2,y1,y2);
    }
  }
  return Array.isArray(a.value) ? a.value.map((v,i)=>v+(b.value[i]-v)*ratio)
    : a.value+(b.value-a.value)*ratio;
}

function transform(track, time) {
  const t=time-track.offset, p=sample(track.position,t), a=sample(track.anchor,t);
  const s=sample(track.scale,t), r=sample(track.rotation,t)*Math.PI/180;
  return multiply(multiply(move(p[0],p[1]),[Math.cos(r)*s[0]/100,Math.sin(r)*s[0]/100,
    -Math.sin(r)*s[1]/100,Math.cos(r)*s[1]/100,0,0]),move(-a[0],-a[1]));
}

function pathData(shape) {
  const {vertices:v,in_tangents:ins,out_tangents:outs,closed}=shape;
  let d=`M ${v[0].join(' ')}`;
  for(let i=0;i<(closed?v.length:v.length-1);i++){
    const j=(i+1)%v.length;
    d+=` C ${v[i][0]+outs[i][0]} ${v[i][1]+outs[i][1]} ${v[j][0]+ins[j][0]} ${v[j][1]+ins[j][1]} ${v[j].join(' ')}`;
  }
  return d+(closed?' Z':'');
}

function drawVectors(items, parent) {
  const group=make('g',{},parent), fill=items.find(i=>i.kind==='fill'), stroke=items.find(i=>i.kind==='stroke');
  if(fill){group.setAttribute('fill',rgba(fill.color));group.setAttribute('fill-opacity',fill.opacity/100);}
  if(stroke){group.setAttribute('stroke',rgba(stroke.color));group.setAttribute('stroke-width',stroke.width);group.setAttribute('stroke-opacity',stroke.opacity/100);group.setAttribute('stroke-linejoin','round');}
  const merge=items.find(i=>i.kind==='merge');
  let paths=items.filter(i=>i.kind==='path');
  // This pack's intersect groups use an enclosing rectangle before the glyph.
  // Preserve the glyph; other compound paths retain their original winding.
  if(merge?.mode===4 && paths.length>1 && paths[0].shape.vertices.length===4) paths=paths.slice(1);
  if(paths.length)make('path',{d:paths.map(p=>pathData(p.shape)).join(' '),'fill-rule':merge?.mode===5?'evenodd':'nonzero'},group);
  for(const item of [...items].reverse()){
    if(item.kind==='group'){
      const p=item.position,a=item.anchor,s=item.scale,r=item.rotation;
      const child=make('g',{transform:`translate(${p}) rotate(${r}) scale(${s[0]/100} ${s[1]/100}) translate(${-a[0]} ${-a[1]})`},group);
      drawVectors(item.children,child);
    }else if(item.kind==='rect')make('rect',{x:item.position[0]-item.size[0]/2,y:item.position[1]-item.size[1]/2,width:item.size[0],height:item.size[1],rx:item.radius},group);
    else if(item.kind==='ellipse')make('ellipse',{cx:item.position[0],cy:item.position[1],rx:item.size[0]/2,ry:item.size[1]/2},group);
  }
}

async function start() {
  const response=await fetch('assets/recipe.json',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw new Error('Source recipe unavailable');
  const bytes=await response.text();
  if(bytes.length>1500000)throw new Error('Recipe exceeds size bound');
  const data=JSON.parse(bytes);
  if(data.sourceSha256!=='373a66686b08aec93b0d1b781baa54edf9954e30aeeff2f7f8778c4b58262069'
    || !Array.isArray(data.cards) || data.cards.length!==17)throw new Error('Unexpected recipe');
  await Promise.all([document.fonts.load('400 74px Manrope'),document.fonts.load('600 74px Manrope'),
    document.fonts.load('300 63px Manrope'),document.fonts.load('400 817px "Bebas Neue"')]);
  const defs=document.querySelector('#definitions'), stage=document.querySelector('#cards');
  const textBindings=new Map(), mediaBindings=new Map();
  const cardsById=new Map(data.cards.map(c=>[c.id,c]));
  const clock={time:0};
  let inputs={...DEFAULTS}, textOverrides={}, mediaOverrides={}, visible=['08','03','06'];
  let serial=0, state={};

  function makeInstance(objects, parent, prefix, phone=false){
    const group=make('g',{'data-instance':prefix},parent);
    const nodes=[];
    for(const object of objects){
      // Native text-shaped glass on the large lock-screen clock is approximated by its text layer.
      if(phone && object.kind==='glass')continue;
      if(!phone && FALLBACK_IDS.has(prefix) && object.kind==='vector')continue;
      const wrapper=make('g',{'data-source-object':object.id,'data-object-kind':object.kind},group);
      const record={object,wrapper};
      if(object.kind==='vector'){
        if(!phone)wrapper.dataset.iconRole=['02','06'].includes(prefix)?'photo-badge'
          :prefix==='03'&&object.id==='16358-16376'?'notification-badge':'primary';
        drawVectors(object.vectors,wrapper);
        if(object.paint){
          const id=`paint-${serial++}`, gradient=make('linearGradient',{id,x2:0,y2:1},defs);
          object.paint.forEach((color,index)=>make('stop',{offset:index,'stop-color':rgba(color)},gradient));
          for(const shape of wrapper.querySelectorAll('path,rect,ellipse'))shape.setAttribute('fill',`url(#${id})`);
        }
      }
      if(object.kind==='text'){
        const t=object.text;
        const weight=t.font.includes('SemiBold')?600:t.font.includes('ExtraLight')?200:t.font.includes('Light')?300:400;
        const attrs={'font-family':t.font.includes('Bebas')?'Bebas Neue':'Manrope','font-size':t.font_size,
          'font-weight':weight,fill:phone?'#eaf0f3':'#111','letter-spacing':t.tracking/1000*t.font_size,
          'text-anchor':t.justification.name==='RIGHT_JUSTIFY'?'end':t.justification.name==='CENTER_JUSTIFY'?'middle':'start'};
        const node=make('text',attrs,wrapper), key=`${prefix}:${object.id}`;
        record.textNode=node;record.key=key;
        textBindings.set(key,{node,document:t,default:t.text,phone});
      }
      if(object.kind==='media'){
        const key=phone?'phone':prefix;
        const clipId=`media-${serial++}`, clip=make('clipPath',{id:clipId},defs);
        const [w,h]=object.size;
        if(!phone){
          record.mediaFallback=make('g',{'data-icon-role':'primary','data-empty-avatar':prefix},wrapper);
          drawMediaFallback(prefix,record.mediaFallback,object.size);
        }
        if(phone)make('rect',{x:(w-1070.9)/2,y:(h-1933.3)/2,width:1070.9,height:1933.3,rx:150},clip);
        else make('circle',{cx:w/2,cy:h/2,r:Math.min(w,h)/2},clip);
        const media=make('g',{'clip-path':`url(#${clipId})`},wrapper);
        if(phone)make('rect',{width:w,height:h,fill:'url(#ribbon)'},media);
        const image=make('image',{width:w,height:h,preserveAspectRatio:'xMidYMid slice',visibility:'hidden'},media);
        const list=mediaBindings.get(key)??[];list.push(image);mediaBindings.set(key,list);
      }
      if(object.kind==='glass'){
        const id=`glass-${serial++}`, [w,h]=object.size, [cx,cy]=object.center;
        const geometry={x:cx-w/2,y:cy-h/2,width:w,height:h,rx:object.radius};
        const clip=make('clipPath',{id:`${id}-clip`,clipPathUnits:'userSpaceOnUse'},defs);
        const clipRect=make('rect',geometry,clip);
        const filter=make('filter',{id,filterUnits:'userSpaceOnUse','color-interpolation-filters':'sRGB'},defs);
        const blur=make('feGaussianBlur',{in:'SourceGraphic',stdDeviation:8,result:'soft'},filter);
        make('feTurbulence',{type:'fractalNoise',baseFrequency:'.008',numOctaves:2,seed:17,result:'noise'},filter);
        const displacement=make('feDisplacementMap',{in:'soft',in2:'noise',scale:10,xChannelSelector:'R',yChannelSelector:'G'},filter);
        // Background sampling lives in world space; the glass outline follows the source matrix.
        const sampleGroup=make('g',{'clip-path':`url(#${id}-clip)`},wrapper);
        make('use',{href:'#scene',filter:`url(#${id})`},sampleGroup);
        const plate=make('g',{},wrapper);
        make('rect',{...geometry,fill:'white','fill-opacity':.25,filter:'url(#shadow)'},plate);
        make('rect',{...geometry,fill:'none',stroke:'white','stroke-opacity':.2,'stroke-width':9},plate);
        make('rect',{...geometry,fill:'none',stroke:'url(#edge)','stroke-width':3},plate);
        Object.assign(record,{clipRect,filter,blur,displacement,plate});
      }
      nodes.push(record);
    }
    if(!phone && FALLBACK_IDS.has(prefix)){
      const wrapper=make('g',{'data-icon-approximation':prefix,'data-icon-role':prefix==='08'?'call-controls':'primary'},group);
      drawFallbackIcon(prefix,wrapper);
      const motion=objects.flatMap(o=>o.chain).find(t=>t.position.bounce);
      nodes.push({wrapper,object:{kind:'fallback',chain:[],start:.0333667,end:10.01001001},motion});
    }
    return {group,nodes};
  }
  const phone=makeInstance(data.phone,document.querySelector('#phoneBackdrop'),'phone',true);
  const phoneMatrix=multiply(move(915.220394,541.124185),multiply(zoom(.5),move(-680,-1080)));
  // Use the actual screen geometry, not its rectangular bounding box: glass
  // and shadows must stay inside the curved screen during the entire entrance.
  const screenClip=make('clipPath',{id:'phoneScreenClip',clipPathUnits:'userSpaceOnUse'},defs);
  make('rect',{x:679.5527873470546-1070.894499334857/2,
    y:1080.3613611352039-1933.2772861338472/2,width:1070.894499334857,
    height:1933.2772861338472,rx:150,transform:matrixAttr(phoneMatrix)},screenClip);
  const instances=new Map(data.cards.map(c=>[c.id,makeInstance(c.objects,stage,c.id)]));
  const presentationMap=new Map(data.presentation.layers.map(l=>[l.id,l]));
  const phonePositions={'01':[915.220394,896.9567],'02':[915.220394,900.0013],
    '03':[915.220394,628.48088],'04':[915.220394,900.0741],'05':[910.52475,896.8443],
    '06':[915.220394,774.40239],'07':[915.220394,898.509],'08':[915.220394,140]};
  const durationFor=view=>view==='presentation'?data.presentation.duration:view==='showcase'?10.01001001001+data.presentation.duration:10.01001001001;
  let timeline;

  function drawText(binding,value){
    const {node,document:t}=binding;
    node.replaceChildren();
    value.replace(/\r/g,'').trimEnd().split('\n').forEach((line,i)=>{
      const span=make('tspan',{x:0,y:i*t.leading},node);span.textContent=line;
    });
  }
  function validate(patch){
    if(!patch || typeof patch!=='object' || Array.isArray(patch) || Object.keys(patch).some(k=>!Object.hasOwn(DEFAULTS,k)))return {ok:false,error:'Unknown inputs'};
    const next={...inputs,...patch};
    if(!['showcase','presentation','phone','card','gallery'].includes(next.view) || !cardsById.has(next.variant)
      || !['wallpaper','grid'].includes(next.background))return {ok:false,error:'Invalid view, variant or background'};
    for(const key of ['x','y','scale','blur','distortion'])if(typeof next[key]!=='number'||!Number.isFinite(next[key]))return {ok:false,error:`Invalid ${key}`};
    if(next.scale<.2||next.scale>1||next.blur<0||next.blur>24||next.distortion<0||next.distortion>30)return {ok:false,error:'Scale/effect outside supported bounds'};
    if(next.x-795*next.scale<0||next.x+795*next.scale>1920||next.y-375*next.scale<0||next.y+555*next.scale>1080)return {ok:false,error:'Card would leave the frame'};
    let texts,media;
    try{
      if(typeof next.texts!=='string'||next.texts.length>16000||typeof next.media!=='string'||next.media.length>4000)throw new Error();
      texts=JSON.parse(next.texts);media=JSON.parse(next.media);
      if(!texts||Array.isArray(texts)||typeof texts!=='object'||!media||Array.isArray(media)||typeof media!=='object')throw new Error();
    }catch{return {ok:false,error:'Text/media bindings must be bounded JSON objects'};}
    for(const [key,value] of Object.entries(texts)){
      if(!textBindings.has(key)||typeof value!=='string'||!value.trim()||value.length>400||/[\u0000-\u0009\u000b-\u001f\u007f]/u.test(value))return {ok:false,error:`Invalid text binding ${key}`};
      const original=textBindings.get(key).document;
      if(value.trimEnd().split('\n').length>original.text.trimEnd().split('\n').length)return {ok:false,error:`Too many lines for ${key}`};
      // Preserve source font size; do not silently stretch or crop text.
      const canvas=document.createElement('canvas').getContext('2d');
      canvas.font=`${original.font.includes('SemiBold')?600:400} ${original.font_size}px ${original.font.includes('Bebas')?'Bebas Neue':'Manrope'}`;
      const originalWidth=Math.max(...original.text.trimEnd().split('\n').map(s=>canvas.measureText(s).width));
      const binding=textBindings.get(key);
      const available=binding.phone?Math.max(originalWidth,320):original.font_size>=130||original.font_size<50
        ?Math.max(originalWidth,180):original.justification.name==='RIGHT_JUSTIFY'?240:original.font_size===73?900:1110;
      if(value.split('\n').some(s=>canvas.measureText(s).width>available))return {ok:false,error:`Text exceeds the source slot: ${key}`};
    }
    for(const [key,value] of Object.entries(media)){
      if(!mediaBindings.has(key)||typeof value!=='string'||!/^assets\/[A-Za-z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(value))return {ok:false,error:'Media must be a named local image inside assets/'};
    }
    if(typeof next.visible!=='string'||next.visible.length>60)return {ok:false,error:'Invalid phone card list'};
    const chosen=next.visible?next.visible.split(','):[];
    if(chosen.length>17||new Set(chosen).size!==chosen.length||chosen.some(id=>!cardsById.has(id)))return {ok:false,error:'Unknown or repeated phone card'};
    return {ok:true,next,texts,media,chosen};
  }
  function drawInstance(instance,time,outer){
    instance.group.style.display='';
    for(const node of instance.nodes){
      const o=node.object;
      const photoBadge=node.wrapper.dataset.iconRole==='photo-badge';
      const shown=time>=o.start && time<o.end && (!photoBadge||Boolean(mediaOverrides[instance.group.dataset.instance]));
      if(node.mediaFallback)node.mediaFallback.style.display=mediaOverrides[instance.group.dataset.instance]?'none':'';
      // display:none also disables referenced SVG content; visibility can be
      // overridden by visible descendants inside the sampled phone scene.
      node.wrapper.style.display=shown?'':'none';
      if(!shown)continue;
      let m=outer;
      for(const track of o.chain)m=multiply(m,transform(track,time));
      if(node.motion){
        const keys=node.motion.position.keys,last=keys[keys.length-1];
        const p=sample(node.motion.position,time-node.motion.offset);
        m=multiply(m,move(p[0]-last.value[0],p[1]-last.value[1]));
      }
      if(o.kind!=='glass')node.wrapper.setAttribute('transform',matrixAttr(m));
      else{
        node.clipRect.setAttribute('transform',matrixAttr(m));node.plate.setAttribute('transform',matrixAttr(m));
        const [cx,cy]=o.center,[w,h]=o.size;
        const corners=[[cx-w/2,cy-h/2],[cx+w/2,cy-h/2],[cx+w/2,cy+h/2],[cx-w/2,cy+h/2]].map(p=>point(m,p));
        const s=Math.hypot(m[0],m[1]), margin=(inputs.blur*4+inputs.distortion+8)*s;
        const xs=corners.map(p=>p[0]),ys=corners.map(p=>p[1]);
        for(const [k,v] of Object.entries({x:Math.min(...xs)-margin,y:Math.min(...ys)-margin,width:Math.max(...xs)-Math.min(...xs)+margin*2,height:Math.max(...ys)-Math.min(...ys)+margin*2}))node.filter.setAttribute(k,v);
        node.blur.setAttribute('stdDeviation',inputs.blur*s);node.displacement.setAttribute('scale',inputs.distortion*s);
      }
    }
  }
  function presentationMatrix(layer,time,depth=0){
    if(depth>24)throw new Error('Invalid presentation parenting');
    const local=transform(layer.transform,time);
    return layer.parent?multiply(presentationMatrix(presentationMap.get(layer.parent),time,depth+1),local):local;
  }
  function render(){
    for(const i of instances.values())i.group.style.display='none';
    phone.group.style.display='none';
    let view=inputs.view,t=clock.time;
    if(view==='showcase'){view=t<10.01001001001?'phone':'presentation';if(view==='presentation')t-=10.01001001001;}
    const shown=[];
    // Source CC Radial Fast Blur: preserve its active window and amount keys,
    // approximating the off-screen radial streak with a modest SVG/CSS blur.
    let blurAmount=0;
    if(view==='presentation' && t>=5.1384718){
      blurAmount=t<6.373039706?4:t<7.073740407?4+(t-6.373039706)/.700700701*36
        :Math.max(0,40*(8.908908909-t)/1.835168502);
    }
    stage.style.filter=blurAmount?`blur(${blurAmount/8}px)`:'none';
    if(view==='phone')stage.setAttribute('clip-path','url(#phoneScreenClip)');
    else stage.removeAttribute('clip-path');
    if(view==='phone'){
      drawInstance(phone,t,phoneMatrix);
      for(const id of t>=.0333667?visible:[]){const pos=phonePositions[id]??[915.220394,898.97545];
        drawInstance(instances.get(id),Math.max(0,t-.0333667),multiply(move(...pos),multiply(zoom(.33),move(-960,-540))));shown.push(id);}
    }else if(view==='presentation'){
      // AE layer order: low layers behind higher layers.
      for(const layer of [...data.presentation.layers].reverse()){
        const card=data.cards.find(c=>c.sourceId===layer.sourceId);
        if(card&&t>=layer.in&&t<layer.out){
          const instance=instances.get(card.id);stage.append(instance.group);
          drawInstance(instance,t-layer.start,presentationMatrix(layer,t));shown.push(card.id);
        }
      }
    }else if(view==='card'){
      drawInstance(instances.get(inputs.variant),t,multiply(move(inputs.x,inputs.y),multiply(zoom(inputs.scale),move(-960,-540))));shown.push(inputs.variant);
    }else{
      data.cards.forEach((card,index)=>{
        const x=320+(index%3)*640,y=88+Math.floor(index/3)*176;
        drawInstance(instances.get(card.id),Math.max(1.3,t),multiply(move(x,y),multiply(zoom(.32),move(-960,-540))));shown.push(card.id);
      });
    }
    state={view,time:t,visible:shown,inputs:{...inputs},duration:durationFor(inputs.view)};
  }
  async function setInputs(patch,signal=AbortSignal.timeout(10000)){
    const valid=validate(patch);if(!valid.ok)return valid;
    try{
      for(const file of new Set(Object.values(valid.media))){
        const asset=await fetch(file,{method:'HEAD',signal});
        const size=Number(asset.headers.get('content-length'));
        if(!asset.ok||!/^image\/(png|jpeg|webp)(;|$)/i.test(asset.headers.get('content-type')??'')
          ||!Number.isFinite(size)||size<=0||size>20*1024*1024)return {ok:false,error:'Media must exist as a local PNG/JPEG/WebP under 20 MiB'};
      }
    }catch{return {ok:false,error:'Could not load local media'};}
    inputs=valid.next;textOverrides=valid.texts;mediaOverrides=valid.media;visible=valid.chosen;
    for(const [key,binding] of textBindings)drawText(binding,textOverrides[key]??binding.default);
    for(const [key,images] of mediaBindings)for(const image of images){
      const file=mediaOverrides[key];image.setAttribute('visibility',file?'visible':'hidden');
      if(file)image.setAttribute('href',file);else image.removeAttribute('href');
    }
    document.querySelector('#gridBackground').setAttribute('visibility',inputs.background==='grid'?'visible':'hidden');
    const duration=durationFor(inputs.view);
    document.querySelector('#composition').dataset.duration=String(duration);
    if(timeline){timeline.clear();clock.time=0;timeline.to(clock,{time:duration,duration,ease:'none',onUpdate:render});}
    render();return {ok:true,state};
  }
  // HyperFrames fixes the export length from the authored data-duration before
  // this script runs, so the chosen view must match it. Fail loudly otherwise.
  const authoredDuration=Number(document.querySelector('#composition').dataset.duration);
  const declarations=JSON.parse(document.documentElement.dataset.compositionVariables??'[]');
  const entryView=Array.isArray(declarations)?declarations.find(item=>item.id==='view')?.default:'showcase';
  const first=await setInputs({view:entryView,...(window.__hyperframes?.getVariables?.()??{})});
  if(!first.ok)throw new Error(first.error);
  if(Math.abs(authoredDuration-durationFor(inputs.view))>1e-3){
    throw new Error(`View "${inputs.view}" needs data-duration="${durationFor(inputs.view)}" on #composition in index.html (found ${authoredDuration}).`);
  }
  timeline=window.gsap.timeline({paused:true});
  timeline.to(clock,{time:durationFor(inputs.view),duration:durationFor(inputs.view),ease:'none',onUpdate:render});
  window.__timelines.main=timeline;
  window.pack={setInputs,getState:()=>state,listCards:()=>data.cards.map(c=>({id:c.id,name:c.name})),
    textSlots:()=>Array.from(textBindings,([key,b])=>({key,text:b.default,fontSize:b.document.font_size})),
    mediaSlots:()=>Array.from(mediaBindings.keys()),destroy:()=>timeline.kill()};
  window.motionReady=true;
  window.addEventListener('pagehide',()=>window.pack.destroy(),{once:true});
}
await start();
