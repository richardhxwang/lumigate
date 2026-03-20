import{_ as j}from"./DraggableContainer.vue_vue_type_script_setup_true_lang-DVVq14Oc.js";import{_ as ee}from"./ExchangeSelect.vue_vue_type_script_setup_true_lang-BOreu38m.js";import{s as te}from"./index-BacdPW1I.js";import{a1 as ne,ad as se,ai as ae,a,c as i,N as D,a4 as re,y as f,A as k,j as x,J as oe,f as n,d as O,F as B,k as U,l as v,b as l,e as t,g as J,h as m,C as le,ce as ie,q as de,r as w,u as ue,U as pe,V as me,i as z,v as ce,X as ge,a5 as fe,$ as F,Y as N,c8 as _e,Z as A,t as ve}from"./index-Beq3SnPG.js";import{u as be,_ as xe,a as ye}from"./pairlistConfig-ChICKENn.js";import{s as we}from"./index-BJs9d5ww.js";import{_ as he}from"./TimeRangeSelect.vue_vue_type_script_setup_true_lang-D6VJDzQY.js";import{_ as ke}from"./check-XXlZxUfW.js";import"./plus-box-outline-CihRrTgn.js";var Ve=`
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
`,Se={root:function(d){var _=d.instance;return["p-progressbar p-component",{"p-progressbar-determinate":_.determinate,"p-progressbar-indeterminate":_.indeterminate}]},value:"p-progressbar-value",label:"p-progressbar-label"},Te=ne.extend({name:"progressbar",style:Ve,classes:Se}),$e={name:"BaseProgressBar",extends:se,props:{value:{type:Number,default:null},mode:{type:String,default:"determinate"},showValue:{type:Boolean,default:!0}},style:Te,provide:function(){return{$pcProgressBar:this,$parentInstance:this}}},I={name:"ProgressBar",extends:$e,inheritAttrs:!1,computed:{progressStyle:function(){return{width:this.value+"%",display:"flex"}},indeterminate:function(){return this.mode==="indeterminate"},determinate:function(){return this.mode==="determinate"},dataP:function(){return ae({determinate:this.determinate,indeterminate:this.indeterminate})}}},De=["aria-valuenow","data-p"],Ce=["data-p"],Pe=["data-p"],Be=["data-p"];function Ue(r,d,_,b,h,o){return a(),i("div",D({role:"progressbar",class:r.cx("root"),"aria-valuemin":"0","aria-valuenow":r.value,"aria-valuemax":"100","data-p":o.dataP},r.ptmi("root")),[o.determinate?(a(),i("div",D({key:0,class:r.cx("value"),style:o.progressStyle,"data-p":o.dataP},r.ptm("value")),[r.value!=null&&r.value!==0&&r.showValue?(a(),i("div",D({key:0,class:r.cx("label"),"data-p":o.dataP},r.ptm("label")),[re(r.$slots,"default",{},function(){return[f(k(r.value+"%"),1)]})],16,Pe)):x("",!0)],16,Ce)):o.indeterminate?(a(),i("div",D({key:1,class:r.cx("value"),"data-p":o.dataP},r.ptm("value")),null,16,Be)):x("",!0)],16,De)}I.render=Ue;const Ee={viewBox:"0 0 24 24",width:"1.2em",height:"1.2em"};function Me(r,d){return a(),i("svg",Ee,[...d[0]||(d[0]=[n("path",{fill:"currentColor",d:"M8 17v-2h8v2zm8-7l-4 4l-4-4h2.5V7h3v3zM5 3h14a2 2 0 0 1 2 2v14c0 1.11-.89 2-2 2H5a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2m0 2v14h14V5z"},null,-1)])])}const ze=oe({name:"mdi-download-box-outline",render:Me}),Fe={class:"flex flex-row items-end gap-1"},Ne={class:"ms-2 w-full grow space-y-1"},Ae=["title"],Oe={key:1},Je={class:"flex justify-between"},Ie={key:1},Re={key:2,class:"w-25"},He={key:3,class:"flex flex-col md:flex-row w-full grow gap-2"},Le=O({__name:"BackgroundJobTracking",setup(r){const{runningJobs:d,clearJobs:_}=ie();return(b,h)=>{const o=ze,C=ke,g=I,u=le,y=J;return a(),i("div",Fe,[n("ul",Ne,[(a(!0),i(B,null,U(t(d),(c,T)=>(a(),i("li",{key:T,class:"border p-1 pb-2 rounded-sm dark:border-surface-700 border-surface-300 flex gap-2 items-center",title:T},[c.taskStatus?.job_category==="download_data"?(a(),v(o,{key:0})):(a(),i("span",Oe,k(c.taskStatus?.job_category),1)),n("div",Je,[c.taskStatus?.status==="success"?(a(),v(C,{key:0,class:"text-success",title:""})):(a(),i("span",Ie,k(c.taskStatus?.status),1)),c.taskStatus?.progress?(a(),i("span",Re,k(c.taskStatus?.progress),1)):x("",!0)]),c.taskStatus?.progress?(a(),v(g,{key:2,class:"w-full grow",value:c.taskStatus?.progress/100*100,"show-progress":"",max:100,striped:""},null,8,["value"])):x("",!0),c.taskStatus?.progress_tasks?(a(),i("div",He,[(a(!0),i(B,null,U(Object.entries(c.taskStatus?.progress_tasks),([P,V])=>(a(),i("div",{key:P,class:"w-full"},[f(k(V.description)+" ",1),l(g,{class:"w-full grow",value:Math.round(V.progress/V.total*100*100)/100,"show-progress":"",pt:{value:{class:c.taskStatus.status==="success"?"bg-emerald-500":"bg-amber-500"}},striped:""},null,8,["value","pt"])]))),128))])):x("",!0)],8,Ae))),128))]),Object.keys(t(d)).length>0?(a(),v(y,{key:0,severity:"secondary",class:"ms-auto",onClick:t(_)},{icon:m(()=>[l(u)]),_:1},8,["onClick"])):x("",!0)])}}}),qe=w([{description:"All USDT Pairs",pairs:[".*/USDT"]},{description:"All USDT Futures Pairs",pairs:[".*/USDT:USDT"]}]);function We(){return{pairTemplates:de(()=>qe.value.map((r,d)=>({...r,idx:d})))}}const Xe={class:"px-1 mx-auto w-full max-w-4xl lg:max-w-7xl"},Ye={class:"flex mb-3 gap-3 flex-col"},Ze={class:"flex flex-col gap-3"},Ge={class:"flex flex-col lg:flex-row gap-3"},Ke={class:"flex-fill"},Qe={class:"flex flex-col gap-2"},je={class:"flex gap-2"},et={class:"flex flex-col gap-1"},tt={class:"flex flex-col gap-1"},nt={class:"flex-fill px-3"},st={class:"flex flex-col gap-2"},at={class:"px-3 border dark:border-surface-700 border-surface-300 p-2 rounded-sm"},rt={class:"flex flex-col gap-2"},ot={class:"flex justify-between items-center"},lt={key:0},it={key:1,class:"flex items-center gap-2"},dt={class:"mb-2 border dark:border-surface-700 border-surface-300 rounded-sm p-2 text-start"},ut={class:"mb-2 border dark:border-surface-700 border-surface-300 rounded-md p-2 text-start"},pt={class:"grid grid-cols md:grid-cols-2 items-center gap-2"},mt={class:"mb-2 border dark:border-surface-700 border-surface-300 rounded-md p-2 text-start"},ct={class:"px-3"},gt=O({__name:"DownloadDataMain",setup(r){const d=ue(),_=be(),b=w(["BTC/USDT","ETH/USDT",""]),h=w(["5m","1h"]),o=w({useCustomTimerange:!1,timerange:"",days:30}),{pairTemplates:C}=We(),g=w({customExchange:!1,selectedExchange:{exchange:"binance",trade_mode:{margin_mode:me.NONE,trading_mode:pe.SPOT}}}),u=w({erase:!1,prepend_data:!1,downloadTrades:!1,candleTypes:[]}),y=w(!1),c=[{text:"Spot",value:"spot"},{text:"Futures",value:"futures"},{text:"Funding Rate",value:"funding_rate"},{text:"Mark",value:"mark"},{text:"Index",value:"index"},{text:"Premium Index",value:"premiumIndex"}];function T(p){b.value.push(...p)}function P(p){b.value=[...p]}async function V(){const p={pairs:b.value.filter(e=>e!==""),timeframes:h.value.filter(e=>e!=="")};o.value.useCustomTimerange&&o.value.timerange?p.timerange=o.value.timerange:p.days=o.value.days,y.value&&(p.erase=u.value.erase,p.download_trades=u.value.downloadTrades,g.value.customExchange&&(p.exchange=g.value.selectedExchange.exchange,p.trading_mode=g.value.selectedExchange.trade_mode.trading_mode,p.margin_mode=g.value.selectedExchange.trade_mode.margin_mode),d.activeBot.botFeatures.downloadDataCandleTypes&&u.value.candleTypes.length>0&&(p.candle_types=u.value.candleTypes),d.activeBot.botFeatures.downloadDataPrepend&&u.value.prepend_data&&(p.prepend_data=!0)),await d.activeBot.startDataDownload(p)}return(p,e)=>{const R=Le,E=xe,$=J,H=ce,S=ge,L=he,q=we,W=fe,X=ye,Y=_e,Z=te,G=ee,K=j;return a(),i("div",Xe,[l(R,{class:"mb-4"}),l(K,{header:"Downloading Data",class:"mx-1 p-4"},{default:m(()=>[n("div",Ye,[n("div",Ze,[n("div",Ge,[n("div",Ke,[n("div",Qe,[e[14]||(e[14]=n("div",{class:"flex justify-between"},[n("h4",{class:"text-start font-bold text-lg"},"Select Pairs"),n("h5",{class:"text-start font-bold text-lg"},"Pairs from template")],-1)),n("div",je,[l(E,{modelValue:t(b),"onUpdate:modelValue":e[0]||(e[0]=s=>z(b)?b.value=s:null),placeholder:"Pair",size:"small",class:"grow"},null,8,["modelValue"]),n("div",et,[n("div",tt,[(a(!0),i(B,null,U(t(C),s=>(a(),v($,{key:s.idx,severity:"secondary",title:s.pairs.reduce((M,Q)=>`${M}${Q}
`,""),onClick:M=>T(s.pairs)},{default:m(()=>[f(k(s.description),1)]),_:2},1032,["title","onClick"]))),128))]),l(H),l($,{disabled:t(_).whitelist.length===0,title:"Add all pairs from Pairlist Config - requires the pairlist config to have ran first.",severity:"secondary",onClick:e[1]||(e[1]=s=>P(t(_).whitelist))},{default:m(()=>[...e[13]||(e[13]=[f(" Use Pairs from Pairlist Config ",-1)])]),_:1},8,["disabled"])])])])]),n("div",nt,[n("div",st,[e[15]||(e[15]=n("h4",{class:"text-start font-bold text-lg"},"Select timeframes",-1)),l(E,{modelValue:t(h),"onUpdate:modelValue":e[2]||(e[2]=s=>z(h)?h.value=s:null),placeholder:"Timeframe"},null,8,["modelValue"])])])]),n("div",at,[n("div",rt,[n("div",ot,[e[17]||(e[17]=n("h4",{class:"text-start mb-0 font-bold text-lg"},"Time Selection",-1)),l(S,{modelValue:t(o).useCustomTimerange,"onUpdate:modelValue":e[3]||(e[3]=s=>t(o).useCustomTimerange=s),class:"mb-0",switch:""},{default:m(()=>[...e[16]||(e[16]=[f(" Use custom timerange ",-1)])]),_:1},8,["modelValue"])]),t(o).useCustomTimerange?(a(),i("div",lt,[l(L,{modelValue:t(o).timerange,"onUpdate:modelValue":e[4]||(e[4]=s=>t(o).timerange=s)},null,8,["modelValue"])])):(a(),i("div",it,[e[18]||(e[18]=n("label",null,"Days to download:",-1)),l(q,{modelValue:t(o).days,"onUpdate:modelValue":e[5]||(e[5]=s=>t(o).days=s),type:"number","aria-label":"Days to download",min:1,step:1,size:"small"},null,8,["modelValue"])]))])]),n("div",dt,[l($,{class:"mb-2",severity:"secondary",onClick:e[6]||(e[6]=s=>y.value=!t(y))},{default:m(()=>[e[19]||(e[19]=f(" Advanced Options ",-1)),t(y)?(a(),v(X,{key:1})):(a(),v(W,{key:0}))]),_:1}),l(F,null,{default:m(()=>[N(n("div",null,[l(Y,{severity:"info",class:"mb-2 py-2"},{default:m(()=>[...e[20]||(e[20]=[f(" Advanced options (Erase data, Download trades, and Custom Exchange settings) will only be applied when this section is expanded. ",-1)])]),_:1}),n("div",ut,[l(S,{modelValue:t(u).erase,"onUpdate:modelValue":e[7]||(e[7]=s=>t(u).erase=s),class:"mb-2"},{default:m(()=>[...e[21]||(e[21]=[f("Erase existing data",-1)])]),_:1},8,["modelValue"]),t(d).activeBot.botFeatures.downloadDataPrepend?(a(),v(S,{key:0,modelValue:t(u).prepend_data,"onUpdate:modelValue":e[8]||(e[8]=s=>t(u).prepend_data=s),class:"mb-2"},{default:m(()=>[...e[22]||(e[22]=[f("Prepend data when downloading",-1)])]),_:1},8,["modelValue"])):x("",!0),l(S,{modelValue:t(u).downloadTrades,"onUpdate:modelValue":e[9]||(e[9]=s=>t(u).downloadTrades=s),class:"mb-2"},{default:m(()=>[...e[23]||(e[23]=[f(" Download Trades instead of OHLCV data ",-1)])]),_:1},8,["modelValue"]),n("div",pt,[t(d).activeBot.botFeatures.downloadDataCandleTypes?(a(),v(Z,{key:0,modelValue:t(u).candleTypes,"onUpdate:modelValue":e[10]||(e[10]=s=>t(u).candleTypes=s),options:c,"option-label":"text","option-value":"value",placeholder:"Select Candle Types"},null,8,["modelValue"])):x("",!0),e[24]||(e[24]=n("small",null,"When no candle-type is selected, the bot will download the necessary candle types for regular operation automatically.",-1))])]),n("div",mt,[l(S,{modelValue:t(g).customExchange,"onUpdate:modelValue":e[11]||(e[11]=s=>t(g).customExchange=s),class:"mb-2"},{default:m(()=>[...e[25]||(e[25]=[f(" Custom Exchange ",-1)])]),_:1},8,["modelValue"]),l(F,{name:"fade"},{default:m(()=>[N(l(G,{modelValue:t(g).selectedExchange,"onUpdate:modelValue":e[12]||(e[12]=s=>t(g).selectedExchange=s)},null,8,["modelValue"]),[[A,t(g).customExchange]])]),_:1})])],512),[[A,t(y)]])]),_:1})]),n("div",ct,[l($,{severity:"primary",onClick:V},{default:m(()=>[...e[26]||(e[26]=[f("Start Download",-1)])]),_:1})])])])]),_:1})])}}}),ft={};function _t(r,d){const _=gt;return a(),v(_,{class:"pt-4"})}const Tt=ve(ft,[["render",_t]]);export{Tt as default};
//# sourceMappingURL=DownloadDataView-kgTjAlOP.js.map
