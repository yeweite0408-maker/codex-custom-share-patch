"""Version-pinned renderer integration. Abort if any native anchor changes."""


def once(source, old, new):
    if source.count(old) != 1:
        raise ValueError(f'Usage integration anchor count differs: {old[:100]}')
    return source.replace(old, new, 1)


def patch_initial(source):
    source = once(source,
        'onNotification(e,t,n=null,r,i=Date.now()){if(this.assertActive(),this.threadExecution==null)throw Error(`App-server manager thread execution is not attached`);',
        'onNotification(e,t,n=null,r,i=Date.now()){if(this.assertActive(),this.threadExecution==null)throw Error(`App-server manager thread execution is not attached`);try{if(e===`turn/started`||e===`turn/completed`||e===`thread/tokenUsage/updated`||e===`account/rateLimits/updated`||e===`account/updated`){globalThis.__codexUsage?.connect(this.hostId,()=>this.requestClient.sendRequest(`account/rateLimits/read`,{}));globalThis.__codexUsage?.notification(e,t,this.hostId,e===`turn/started`?this.threadStore.conversations.get(wi(t.threadId))?.latestTokenUsageInfo:null)}}catch{}')
    source = once(source,
        'async sendRequest(e,t,n){this.assertActive();let r=await this.requestClient.sendRequest(e,t,n);',
        'async sendRequest(e,t,n){this.assertActive();try{globalThis.__codexUsage?.connect(this.hostId,()=>this.requestClient.sendRequest(`account/rateLimits/read`,{}))}catch{}let r=await this.requestClient.sendRequest(e,t,n);')
    return source


def patch_turn(source):
    source = once(source,
        '(rs,{messageActions:r,messageHeader:i,renderItems:Jt,',
        '(rs,{usageTurnId:v,usageLatest:U,messageActions:r,messageHeader:i,renderItems:Jt,')
    source = once(source,
        't[49]=ve}else ve=t[49];return ve}function is(e)',
        't[49]=ve}else ve=t[49];return(0,Z.jsxs)(Z.Fragment,{children:[ve,(0,Z.jsx)(`codex-usage-footer`,{\"host-id\":l,\"thread-id\":s,\"turn-id\":e.usageTurnId??``,latest:e.usageLatest?`true`:`false`})]})}function is(e)')
    source = once(source,
        't[245]=vo):vo=t[245],vo}function Ic(e)',
        't[245]=vo):vo=t[245],(0,$.jsxs)($.Fragment,{children:[vo,(0,$.jsx)(`codex-usage-footer`,{\"host-id\":d,\"thread-id\":u,\"turn-id\":v??``,latest:U?`true`:`false`})]})}function Ic(e)')
    return source
