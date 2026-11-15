export const EMPTY = {type:'FeatureCollection',features:[]};
export function rectangle(a,b){
 const west=Math.min(a.lng,b.lng),east=Math.max(a.lng,b.lng),south=Math.min(a.lat,b.lat),north=Math.max(a.lat,b.lat);
 if(east-west<.0001||north-south<.0001||east-west>180)return null;
 return {type:'FeatureCollection',features:[{type:'Feature',properties:{name:'Custom area'},geometry:{type:'Polygon',coordinates:[[[west,south],[east,south],[east,north],[west,north],[west,south]]]}}]};
}
export function regionShape(country,provinces,name){
 if(name==='World')return EMPTY;
 if(name==='China')return country;
 return {type:'FeatureCollection',features:provinces.features.filter(f=>f.properties.shapeName.toLowerCase().includes(name.toLowerCase()))};
}
export function addLandscape(m){
 m.addSource('satellite',{type:'raster',tiles:['https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg'],tileSize:256,maxzoom:13,attribution:'<a href="https://s2maps.eu">Sentinel-2 cloudless 2020 © EOX</a> · Copernicus Sentinel data'});
 m.addLayer({id:'satellite',type:'raster',source:'satellite',layout:{visibility:'none'},paint:{'raster-saturation':-1,'raster-brightness-min':.08,'raster-brightness-max':.7}});
 for(const id of ['terrain-dem','shade-dem'])m.addSource(id,{type:'raster-dem',url:'https://tiles.mapterhorn.com/tilejson.json',encoding:'terrarium',tileSize:512,maxzoom:12});
 m.addLayer({id:'hillshade',type:'hillshade',source:'shade-dem',paint:{'hillshade-exaggeration':.45,'hillshade-shadow-color':'#10161a','hillshade-highlight-color':'#d5d9d8','hillshade-accent-color':'#5a6368'}});
 m.addSource('focus-area',{type:'geojson',data:EMPTY,attribution:'Boundaries: <a href="https://www.geoboundaries.org">geoBoundaries</a> (public domain source)'});
 m.addLayer({id:'focus-fill',type:'fill',source:'focus-area',paint:{'fill-color':'#ff8c42','fill-opacity':.28}});
 m.addLayer({id:'focus-halo',type:'line',source:'focus-area',paint:{'line-color':'#ff812f','line-width':14,'line-blur':10,'line-opacity':.7}});
 m.addLayer({id:'focus-edge',type:'line',source:'focus-area',paint:{'line-color':'#ffb875','line-width':1.8,'line-opacity':.95}});
}
