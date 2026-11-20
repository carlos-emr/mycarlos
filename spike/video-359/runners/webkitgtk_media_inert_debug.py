import sys, json, os
sys.path.insert(0, os.environ["RUNNERS"])
import webkitgtk_runner as w
class A: pass
a=A(); a.sizes=""; a.bps_per_pixel=1; a.fixture=None; a.save_clips=None; a.no_record=True
sp=w.Spike(a)
data=open(sys.argv[1],'rb').read()
sp.clips={"f.webm":(data,"video/webm"),"page.html":(b"<!doctype html><title>x</title><body>x",'text/html')}
srv=w.RangeServer(sp.clips)
from gi.repository import GLib
done={}
def changed(view,event):
    if event==w.WebKit2.LoadEvent.FINISHED: done['ok']=True; sp.loop.quit()
sp.view.connect("load-changed",changed)
sp.view.load_uri(f"http://127.0.0.1:{srv.port}/page.html")
GLib.timeout_add_seconds(20, lambda:(sp.loop.quit(),False)[1])
sp.loop.run()
print("page loaded over http:", done)
st=sp.view.get_settings()
print("enable_media", st.get_enable_media(), "mediasource", st.get_enable_mediasource(), "gesture", st.get_media_playback_requires_user_gesture(), "inline", st.get_media_playback_allows_inline(), "hw", st.get_hardware_acceleration_policy())
st.set_hardware_acceleration_policy(w.WebKit2.HardwareAccelerationPolicy.NEVER)
url=f"http://127.0.0.1:{srv.port}/f.webm"
tests={
 "created-no-preload": f"""(async()=>{{const v=document.createElement('video');const ev=[];['loadstart','loadedmetadata','error','suspend','stalled','emptied','abort'].forEach(e=>v.addEventListener(e,()=>ev.push(e)));document.body.appendChild(v);v.src='{url}';await new Promise(r=>setTimeout(r,4000));return {{ev,ns:v.networkState,rs:v.readyState,err:v.error&&v.error.message,cur:v.currentSrc}}}})()""",
 "markup": f"""(async()=>{{document.body.insertAdjacentHTML('beforeend','<video id=m controls muted src="{url}"></video>');const v=document.getElementById('m');const ev=[];['loadstart','loadedmetadata','error'].forEach(e=>v.addEventListener(e,()=>ev.push(e)));await new Promise(r=>setTimeout(r,4000));return {{ev,ns:v.networkState,rs:v.readyState,err:v.error&&v.error.message}}}})()""",
 
 "feat": """(()=>{return {mse: typeof MediaSource, mmse: typeof ManagedMediaSource, ua: navigator.userAgent}})()""",
}
for k,sc in tests.items():
    print(k, json.dumps(sp.js(sc, timeout_s=30)))
print("http log", srv.log[:5])
