import{_ as j}from"./DraggableContainer.vue_vue_type_script_setup_true_lang-EpHNMxQw.js";import{_ as ee}from"./ExchangeSelect.vue_vue_type_script_setup_true_lang-BQa0_Jpo.js";import{s as te}from"./index-Dfn3KQQw.js";import{Y as ne,ad as se,ai as ae,a,c as i,E as $,a0 as re,h as f,t as h,n as x,d as z,e as s,F as B,r as U,l as v,cf as oe,ab as le,f as l,g as t,s as I,w as m,j as ie,cg as de,q as ue,p as w,b as pe,N as me,O as ce,m as M,Q as ge,a1 as fe,U as N,R as O,cd as _e,S as A,X as ve}from"./index-BBmdWKvw.js";import{u as be,_ as xe,a as ye}from"./pairlistConfig-DK-kHuFQ.js";import{s as we}from"./index-0FmEocXn.js";import{_ as ke}from"./TimeRangeSelect.vue_vue_type_script_setup_true_lang-Djhzj0ss.js";import{s as he}from"./index-c6Ugd6cY.js";import"./plus-square-DlO0JxbO.js";var Se=`
    .p-progressbar {
        display: block;
        position: relative;
        overflow: hidden;
        height: dt('progressbar.height');
        background: dt('progressbar.background');
        border-radius: dt('progressbar.border.radius');
    }

    .p-progressbar-value {
        margin: 0;
        background: dt('progressbar.value.background');
    }

    .p-progressbar-label {
        color: dt('progressbar.label.color');
        font-size: dt('progressbar.label.font.size');
        font-weight: dt('progressbar.label.font.weight');
    }

    .p-progressbar-determinate .p-progressbar-value {
        height: 100%;
        width: 0%;
        position: absolute;
        display: none;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        transition: width 1s ease-in-out;
    }

    .p-progressbar-determinate .p-progressbar-label {
        display: inline-flex;
    }

    .p-progressbar-indeterminate .p-progressbar-value::before {
        content: '';
        position: absolute;
        background: inherit;
        inset-block-start: 0;
        inset-inline-start: 0;
        inset-block-end: 0;
        will-change: inset-inline-start, inset-inline-end;
        animation: p-progressbar-indeterminate-anim 2.1s cubic-bezier(0.65, 0.815, 0.735, 0.395) infinite;
    }

    .p-progressbar-indeterminate .p-progressbar-value::after {
        content: '';
        position: absolute;
        background: inherit;
        inset-block-start: 0;
        inset-inline-start: 0;
        inset-block-end: 0;
        will-change: inset-inline-start, inset-inline-end;
        animation: p-progressbar-indeterminate-anim-short 2.1s cubic-bezier(0.165, 0.84, 0.44, 1) infinite;
        animation-delay: 1.15s;
    }

    @keyframes p-progressbar-indeterminate-anim {
        0% {
            inset-inline-start: -35%;
            inset-inline-end: 100%;
        }
        60% {
            inset-inline-start: 100%;
            inset-inline-end: -90%;
        }
        100% {
            inset-inline-start: 100%;
            inset-inline-end: -90%;
        }
    }
    @-webkit-keyframes p-progressbar-indeterminate-anim {
        0% {
            inset-inline-start: -35%;
            inset-inline-end: 100%;
        }
        60% {
            inset-inline-start: 100%;
            inset-inline-end: -90%;
        }
        100% {
            inset-inline-start: 100%;
            inset-inline-end: -90%;
        }
    }

    @keyframes p-progressbar-indeterminate-anim-short {
        0% {
            inset-inline-start: -200%;
            inset-inline-end: 100%;
        }
        60% {
            inset-inline-start: 107%;
            inset-inline-end: -8%;
        }
        100% {
            inset-inline-start: 107%;
            inset-inline-end: -8%;
        }
    }
    @-webkit-keyframes p-progressbar-indeterminate-anim-short {
        0% {
            inset-inline-start: -200%;
            inset-inline-end: 100%;
        }
        60% {
            inset-inline-start: 107%;
            inset-inline-end: -8%;
        }
        100% {
            inset-inline-start: 107%;
            inset-inline-end: -8%;
        }
    }
`,Te={root:function(p){var _=p.instance;return["p-progressbar p-component",{"p-progressbar-determinate":_.determinate,"p-progressbar-indeterminate":_.indeterminate}]},value:"p-progressbar-value",label:"p-progressbar-label"},Ve=ne.extend({name:"progressbar",style:Se,classes:Te}),De={name:"BaseProgressBar",extends:se,props:{value:{type:Number,default:null},mode:{type:String,default:"determinate"},showValue:{type:Boolean,default:!0}},style:Ve,provide:function(){return{$pcProgressBar:this,$parentInstance:this}}},J={name:"ProgressBar",extends:De,inheritAttrs:!1,computed:{progressStyle:function(){return{width:this.value+"%",display:"flex"}},indeterminate:function(){return this.mode==="indeterminate"},determinate:function(){return this.mode==="determinate"},dataP:function(){return ae({determinate:this.determinate,indeterminate:this.indeterminate})}}},$e=["aria-valuenow","data-p"],Pe=["data-p"],Ce=["data-p"],Be=["data-p"];function Ue(r,p,_,b,k,o){return a(),i("div",$({role:"progressbar",class:r.cx("root"),"aria-valuemin":"0","aria-valuenow":r.value,"aria-valuemax":"100","data-p":o.dataP},r.ptmi("root")),[o.determinate?(a(),i("div",$({key:0,class:r.cx("value"),style:o.progressStyle,"data-p":o.dataP},r.ptm("value")),[r.value!=null&&r.value!==0&&r.showValue?(a(),i("div",$({key:0,class:r.cx("label"),"data-p":o.dataP},r.ptm("label")),[re(r.$slots,"default",{},function(){return[f(h(r.value+"%"),1)]})],16,Ce)):x("",!0)],16,Pe)):o.indeterminate?(a(),i("div",$({key:1,class:r.cx("value"),"data-p":o.dataP},r.ptm("value")),null,16,Be)):x("",!0)],16,$e)}J.render=Ue;const Ee={class:"flex flex-row items-end gap-1"},Fe={class:"ms-2 w-full grow space-y-1"},Me=["title"],Ne={key:1},Oe={class:"flex justify-between"},Ae={key:1},ze={key:2,class:"w-25"},Ie={key:3,class:"flex flex-col md:flex-row w-full grow gap-2"},Je=z({__name:"BackgroundJobTracking",setup(r){const{runningJobs:p,clearJobs:_}=de();return(b,k)=>{const o=oe,P=le,g=J,d=ie,y=I;return a(),i("div",Ee,[s("ul",Fe,[(a(!0),i(B,null,U(t(p),(c,V)=>(a(),i("li",{key:V,class:"border p-1 pb-2 rounded-2xl dark:border-surface-700 border-surface-300 flex gap-2 items-center",title:V},[c.taskStatus?.job_category==="download_data"?(a(),v(o,{key:0})):(a(),i("span",Ne,h(c.taskStatus?.job_category),1)),s("div",Oe,[c.taskStatus?.status==="success"?(a(),v(P,{key:0,class:"text-success",title:""})):(a(),i("span",Ae,h(c.taskStatus?.status),1)),c.taskStatus?.progress?(a(),i("span",ze,h(c.taskStatus?.progress),1)):x("",!0)]),c.taskStatus?.progress?(a(),v(g,{key:2,class:"w-full grow",value:c.taskStatus?.progress/100*100,"show-progress":"",max:100,striped:""},null,8,["value"])):x("",!0),c.taskStatus?.progress_tasks?(a(),i("div",Ie,[(a(!0),i(B,null,U(Object.entries(c.taskStatus?.progress_tasks),([C,S])=>(a(),i("div",{key:C,class:"w-full"},[f(h(S.description)+" ",1),l(g,{class:"w-full grow",value:Math.round(S.progress/S.total*100*100)/100,"show-progress":"",pt:{value:{class:c.taskStatus.status==="success"?"bg-emerald-500":"bg-amber-500"}},striped:""},null,8,["value","pt"])]))),128))])):x("",!0)],8,Me))),128))]),Object.keys(t(p)).length>0?(a(),v(y,{key:0,severity:"secondary",class:"ms-auto",onClick:t(_)},{icon:m(()=>[l(d)]),_:1},8,["onClick"])):x("",!0)])}}}),Re=w([{description:"All USDT Pairs",pairs:[".*/USDT"]},{description:"All USDT Futures Pairs",pairs:[".*/USDT:USDT"]}]);function Le(){return{pairTemplates:ue(()=>Re.value.map((r,p)=>({...r,idx:p})))}}const qe={class:"px-1 mx-auto w-full max-w-4xl lg:max-w-7xl"},He={class:"flex mb-3 gap-3 flex-col"},Qe={class:"flex flex-col gap-3"},We={class:"flex flex-col lg:flex-row gap-3"},Xe={class:"flex-fill"},Ye={class:"flex flex-col gap-2"},Ge={class:"flex gap-2"},Ke={class:"flex flex-col gap-1"},Ze={class:"flex flex-col gap-1"},je={class:"flex-fill px-3"},et={class:"flex flex-col gap-2"},tt={class:"px-3 border dark:border-surface-700 border-surface-300 p-2 rounded-2xl"},nt={class:"flex flex-col gap-2"},st={class:"flex justify-between items-center"},at={key:0},rt={key:1,class:"flex items-center gap-2"},ot={class:"mb-2 border dark:border-surface-700 border-surface-300 rounded-2xl p-2 text-start"},lt={class:"mb-2 border dark:border-surface-700 border-surface-300 rounded-md p-2 text-start"},it={class:"grid grid-cols md:grid-cols-2 items-center gap-2"},dt={class:"mb-2 border dark:border-surface-700 border-surface-300 rounded-md p-2 text-start"},ut={class:"px-3"},pt=z({__name:"DownloadDataMain",setup(r){const p=pe(),_=be(),b=w(["BTC/USDT","ETH/USDT",""]),k=w(["5m","1h"]),o=w({useCustomTimerange:!1,timerange:"",days:30}),{pairTemplates:P}=Le(),g=w({customExchange:!1,selectedExchange:{exchange:"binance",trade_mode:{margin_mode:ce.NONE,trading_mode:me.SPOT}}}),d=w({erase:!1,prepend_data:!1,downloadTrades:!1,candleTypes:[]}),y=w(!1),c=[{text:"Spot",value:"spot"},{text:"Futures",value:"futures"},{text:"Funding Rate",value:"funding_rate"},{text:"Mark",value:"mark"},{text:"Index",value:"index"},{text:"Premium Index",value:"premiumIndex"}];function V(u){b.value.push(...u)}function C(u){b.value=[...u]}async function S(){const u={pairs:b.value.filter(e=>e!==""),timeframes:k.value.filter(e=>e!=="")};o.value.useCustomTimerange&&o.value.timerange?u.timerange=o.value.timerange:u.days=o.value.days,y.value&&(u.erase=d.value.erase,u.download_trades=d.value.downloadTrades,g.value.customExchange&&(u.exchange=g.value.selectedExchange.exchange,u.trading_mode=g.value.selectedExchange.trade_mode.trading_mode,u.margin_mode=g.value.selectedExchange.trade_mode.margin_mode),p.activeBot.botFeatures.downloadDataCandleTypes&&d.value.candleTypes.length>0&&(u.candle_types=d.value.candleTypes),p.activeBot.botFeatures.downloadDataPrepend&&d.value.prepend_data&&(u.prepend_data=!0)),await p.activeBot.startDataDownload(u)}return(u,e)=>{const R=Je,E=xe,D=I,L=he,T=ge,q=ke,H=we,Q=fe,W=ye,X=_e,Y=te,G=ee,K=j;return a(),i("div",qe,[l(R,{class:"mb-4"}),l(K,{header:"Downloading Data",class:"mx-1 p-4"},{default:m(()=>[s("div",He,[s("div",Qe,[s("div",We,[s("div",Xe,[s("div",Ye,[e[14]||(e[14]=s("div",{class:"flex justify-between"},[s("h4",{class:"text-start font-bold text-lg"},"Select Pairs"),s("h5",{class:"text-start font-bold text-lg"},"Pairs from template")],-1)),s("div",Ge,[l(E,{modelValue:t(b),"onUpdate:modelValue":e[0]||(e[0]=n=>M(b)?b.value=n:null),placeholder:"Pair",size:"small",class:"grow"},null,8,["modelValue"]),s("div",Ke,[s("div",Ze,[(a(!0),i(B,null,U(t(P),n=>(a(),v(D,{key:n.idx,severity:"secondary",title:n.pairs.reduce((F,Z)=>`${F}${Z}
`,""),onClick:F=>V(n.pairs)},{default:m(()=>[f(h(n.description),1)]),_:2},1032,["title","onClick"]))),128))]),l(L),l(D,{disabled:t(_).whitelist.length===0,title:"Add all pairs from Pairlist Config - requires the pairlist config to have ran first.",severity:"secondary",onClick:e[1]||(e[1]=n=>C(t(_).whitelist))},{default:m(()=>[...e[13]||(e[13]=[f(" Use Pairs from Pairlist Config ",-1)])]),_:1},8,["disabled"])])])])]),s("div",je,[s("div",et,[e[15]||(e[15]=s("h4",{class:"text-start font-bold text-lg"},"Select timeframes",-1)),l(E,{modelValue:t(k),"onUpdate:modelValue":e[2]||(e[2]=n=>M(k)?k.value=n:null),placeholder:"Timeframe"},null,8,["modelValue"])])])]),s("div",tt,[s("div",nt,[s("div",st,[e[17]||(e[17]=s("h4",{class:"text-start mb-0 font-bold text-lg"},"Time Selection",-1)),l(T,{modelValue:t(o).useCustomTimerange,"onUpdate:modelValue":e[3]||(e[3]=n=>t(o).useCustomTimerange=n),class:"mb-0",switch:""},{default:m(()=>[...e[16]||(e[16]=[f(" Use custom timerange ",-1)])]),_:1},8,["modelValue"])]),t(o).useCustomTimerange?(a(),i("div",at,[l(q,{modelValue:t(o).timerange,"onUpdate:modelValue":e[4]||(e[4]=n=>t(o).timerange=n)},null,8,["modelValue"])])):(a(),i("div",rt,[e[18]||(e[18]=s("label",null,"Days to download:",-1)),l(H,{modelValue:t(o).days,"onUpdate:modelValue":e[5]||(e[5]=n=>t(o).days=n),type:"number","aria-label":"Days to download",min:1,step:1,size:"small"},null,8,["modelValue"])]))])]),s("div",ot,[l(D,{class:"mb-2",severity:"secondary",onClick:e[6]||(e[6]=n=>y.value=!t(y))},{default:m(()=>[e[19]||(e[19]=f(" Advanced Options ",-1)),t(y)?(a(),v(W,{key:1})):(a(),v(Q,{key:0}))]),_:1}),l(N,null,{default:m(()=>[O(s("div",null,[l(X,{severity:"info",class:"mb-2 py-2"},{default:m(()=>[...e[20]||(e[20]=[f(" Advanced options (Erase data, Download trades, and Custom Exchange settings) will only be applied when this section is expanded. ",-1)])]),_:1}),s("div",lt,[l(T,{modelValue:t(d).erase,"onUpdate:modelValue":e[7]||(e[7]=n=>t(d).erase=n),class:"mb-2"},{default:m(()=>[...e[21]||(e[21]=[f("Erase existing data",-1)])]),_:1},8,["modelValue"]),t(p).activeBot.botFeatures.downloadDataPrepend?(a(),v(T,{key:0,modelValue:t(d).prepend_data,"onUpdate:modelValue":e[8]||(e[8]=n=>t(d).prepend_data=n),class:"mb-2"},{default:m(()=>[...e[22]||(e[22]=[f("Prepend data when downloading",-1)])]),_:1},8,["modelValue"])):x("",!0),l(T,{modelValue:t(d).downloadTrades,"onUpdate:modelValue":e[9]||(e[9]=n=>t(d).downloadTrades=n),class:"mb-2"},{default:m(()=>[...e[23]||(e[23]=[f(" Download Trades instead of OHLCV data ",-1)])]),_:1},8,["modelValue"]),s("div",it,[t(p).activeBot.botFeatures.downloadDataCandleTypes?(a(),v(Y,{key:0,modelValue:t(d).candleTypes,"onUpdate:modelValue":e[10]||(e[10]=n=>t(d).candleTypes=n),options:c,"option-label":"text","option-value":"value",placeholder:"Select Candle Types"},null,8,["modelValue"])):x("",!0),e[24]||(e[24]=s("small",null,"When no candle-type is selected, the bot will download the necessary candle types for regular operation automatically.",-1))])]),s("div",dt,[l(T,{modelValue:t(g).customExchange,"onUpdate:modelValue":e[11]||(e[11]=n=>t(g).customExchange=n),class:"mb-2"},{default:m(()=>[...e[25]||(e[25]=[f(" Custom Exchange ",-1)])]),_:1},8,["modelValue"]),l(N,{name:"fade"},{default:m(()=>[O(l(G,{modelValue:t(g).selectedExchange,"onUpdate:modelValue":e[12]||(e[12]=n=>t(g).selectedExchange=n)},null,8,["modelValue"]),[[A,t(g).customExchange]])]),_:1})])],512),[[A,t(y)]])]),_:1})]),s("div",ut,[l(D,{severity:"primary",onClick:S},{default:m(()=>[...e[26]||(e[26]=[f("Start Download",-1)])]),_:1})])])])]),_:1})])}}}),mt={};function ct(r,p){const _=pt;return a(),v(_,{class:"pt-4"})}const ht=ve(mt,[["render",ct]]);export{ht as default};
//# sourceMappingURL=DownloadDataView-C5XmmzSD.js.map
