export const cities=[
 {name:'Shanghai',sub:'Lujiazui · Huangpu river',center:[121.4998,31.2397],zoom:14.8,bearing:-35},
 {name:'Beijing',sub:'Guomao · Central business district',center:[116.4595,39.909],zoom:14.8,bearing:25},
 {name:'Shenzhen',sub:'Futian · Civic centre',center:[114.0579,22.5431],zoom:14.8,bearing:-25},
 {name:'Chengdu',sub:'Tianfu Square · Sichuan',center:[104.0657,30.657],zoom:14.8,bearing:35},
 {name:'Chongqing',sub:'Yuzhong · Two rivers',center:[106.5806,29.5582],zoom:14.8,bearing:-40},
 {name:'Hong Kong',sub:'Central · Victoria Harbour',center:[114.1594,22.2802],zoom:15,bearing:35}
];
export function focusGeometry(area){
 const polygons=(area?.features||[]).flatMap(f=>f.geometry.type==='Polygon'?[f.geometry.coordinates]:f.geometry.type==='MultiPolygon'?f.geometry.coordinates:[]);
 return polygons.length?{type:'MultiPolygon',coordinates:polygons}:null;
}
export function addCityLayers(m){
 m.addSource('urban',{type:'vector',url:'https://tiles.openfreemap.org/planet',attribution:'<a href="https://openfreemap.org">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'});
 m.addLayer({id:'urban-land',type:'fill',source:'urban','source-layer':'landcover',paint:{'fill-color':'#34424a','fill-opacity':.65}},'hillshade');
 m.addLayer({id:'urban-water',type:'fill',source:'urban','source-layer':'water',paint:{'fill-color':'#20343f'}},'hillshade');
 m.addLayer({id:'water-edge',type:'line',source:'urban','source-layer':'water',minzoom:8,paint:{'line-color':'#8aadb8','line-opacity':.28,'line-width':['interpolate',['linear'],['zoom'],8,.4,16,1.4]}});
 m.addLayer({id:'urban-rivers',type:'line',source:'urban','source-layer':'waterway',minzoom:8,paint:{'line-color':'#365563','line-width':['interpolate',['linear'],['zoom'],8,.5,16,3]}});
 m.addLayer({id:'urban-roads',type:'line',source:'urban','source-layer':'transportation',minzoom:12,paint:{'line-color':'#aeb9bc','line-opacity':.4,'line-width':['interpolate',['linear'],['zoom'],12,.35,17,1.3]}});
 m.addSource('urban-shapes',{type:'geojson',data:{type:'FeatureCollection',features:[]}});
 m.addLayer({id:'urban-buildings',type:'fill-extrusion',source:'urban-shapes',minzoom:14,filter:['!=',['get','hide_3d'],true],paint:{'fill-extrusion-color':['case',['==',['get','focus'],true],'#f3b082','#59666d'],'fill-extrusion-height':['interpolate',['linear'],['zoom'],14,0,15,['max',3,['to-number',['get','render_height'],9]]],'fill-extrusion-base':['interpolate',['linear'],['zoom'],14,0,15,['max',0,['to-number',['get','render_min_height'],0]]],'fill-extrusion-opacity':.97,'fill-extrusion-vertical-gradient':true}});
 m.setLight({anchor:'viewport',color:'#ffe1ca',intensity:.48,position:[1.5,210,38]});
}
// The style `within` expression supports points/lines, not building polygons.
// Classify loaded building footprints by a representative centre in lon/lat.
function inRing(p,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){const a=ring[i],b=ring[j];if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}
export function inFocus(point,area){const g=focusGeometry(area);return !!g?.coordinates.some(poly=>inRing(point,poly[0])&&!poly.slice(1).some(hole=>inRing(point,hole)));}
export function buildingCentre(geometry){const ring=geometry.type==='Polygon'?geometry.coordinates[0]:geometry.coordinates[0][0];const pts=ring.slice(0,-1);return [pts.reduce((s,p)=>s+p[0],0)/pts.length,pts.reduce((s,p)=>s+p[1],0)/pts.length];}
export function connectBuildings(m){
 let focus=null,timer;const update=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!m.getSource('urban-shapes'))return;if(m.getZoom()<14){m.getSource('urban-shapes').setData({type:'FeatureCollection',features:[]});return;}const seen=new Set();const features=m.querySourceFeatures('urban',{'sourceLayer':'building'}).filter(f=>f.properties.hide_3d!==true).flatMap(f=>{if(!['Polygon','MultiPolygon'].includes(f.geometry.type))return [];const key=JSON.stringify(f.geometry);if(seen.has(key))return [];seen.add(key);return [{type:'Feature',geometry:f.geometry,properties:{...f.properties,focus:inFocus(buildingCentre(f.geometry),focus)}}];});m.getSource('urban-shapes').setData({type:'FeatureCollection',features});},100);};
 const onSource=e=>{if(e.sourceId==='urban'&&e.isSourceLoaded)update();};m.on('sourcedata',onSource);m.on('moveend',update);update();return {setFocus(area){focus=area;update();},destroy(){clearTimeout(timer);m.off('sourcedata',onSource);m.off('moveend',update);}};
}
