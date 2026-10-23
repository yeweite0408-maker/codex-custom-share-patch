"""Native titlebar + narrow adapter hooks for Codex 26.1013."""
from patch_usage_footer import once


ATTACH = ('try{if(globalThis.__codexAutoResume&&globalThis.CodexAutoResumeAdapter)'
    'globalThis.__codexAutoResume.attach(this.hostId,globalThis.CodexAutoResumeAdapter.create(this,'
    '{normalizeThread:wi,latest:Ub,lastServer:X0t,createId:()=>this.history.createSearchIslandId(),'
    'canResume:(e,t)=>globalThis.__codexAutoResume.canResume(this.hostId,e,t),'
    'isUsageLimitError:globalThis.CodexAutoResumeEngine.isUsageLimitError}))}catch{}')


def patch_initial(source):
    anchor = 'throw Error(`App-server manager thread execution is not attached`);'
    # The class also has an onRequest guard. Select the onNotification method.
    begin = source.index('onNotification(e,t,n=null,r,i=Date.now()){')
    end = source.index('onRequest(e){', begin)
    part = source[begin:end]
    part = once(part, anchor, anchor + ATTACH +
        'try{if(e===`turn/started`||e===`turn/completed`||e===`error`||e===`thread/archived`||e===`thread/deleted`||e===`account/updated`||e===`account/rateLimits/updated`)globalThis.__codexAutoResume?.notify(this.hostId,e,t)}catch{}')
    source = source[:begin] + part + source[end:]
    anchor = 'async sendRequest(e,t,n){this.assertActive();'
    source = once(source, anchor, anchor + ATTACH)
    return source


def patch_header(source):
    source = once(source, 't[14]=b,t[15]=e),e}let N;',
        't[14]=b,t[15]=e),(0,ls.jsxs)(ls.Fragment,{children:[e,__codexAutoResumeHeader(ne.id,r)]})}let N;')
    source = once(source, 't[43]=R):R=t[43],R}var cs,ls;',
        't[43]=R):R=t[43],(0,ls.jsxs)(ls.Fragment,{children:[R,__codexAutoResumeHeader(ne.id,r)]})}var cs,ls;')
    source += ('\nfunction __codexAutoResumeHeader(e,t){return t==null?null:(0,ls.jsx)(tn.HeaderAction,'
        '{actionId:`codex-quota-auto-resume`,align:`end`,order:9999,slotPosition:`thread`,unifiedSlotPosition:`threadSummary`,'
        'children:(0,ls.jsx)(`codex-auto-resume-toggle`,{"host-id":e,"thread-id":t})})}\n')
    return source
