import{Y as b,ae as y,a as o,c as i,a0 as k,E as g,A as E,e as c,d as P,o as M,M as j,aa as F,g as m,l as v,a7 as R,m as W,P as q,F as _,f as p,s as O,w as d,ab as T,n as f,j as U,ac as Y,ax as H,p as x}from"./index-BRug2Hfe.js";import{_ as J}from"./plus-square-BryBVfNY.js";var K=`
    .p-inputgroup,
    .p-inputgroup .p-iconfield,
    .p-inputgroup .p-floatlabel,
    .p-inputgroup .p-iftalabel {
        display: flex;
        align-items: stretch;
        width: 100%;
    }

    .p-inputgroup .p-inputtext,
    .p-inputgroup .p-inputwrapper {
        flex: 1 1 auto;
        width: 1%;
    }

    .p-inputgroupaddon {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: dt('inputgroup.addon.padding');
        background: dt('inputgroup.addon.background');
        color: dt('inputgroup.addon.color');
        border-block-start: 1px solid dt('inputgroup.addon.border.color');
        border-block-end: 1px solid dt('inputgroup.addon.border.color');
        min-width: dt('inputgroup.addon.min.width');
    }

    .p-inputgroupaddon:first-child,
    .p-inputgroupaddon + .p-inputgroupaddon {
        border-inline-start: 1px solid dt('inputgroup.addon.border.color');
    }

    .p-inputgroupaddon:last-child {
        border-inline-end: 1px solid dt('inputgroup.addon.border.color');
    }

    .p-inputgroupaddon:has(.p-button) {
        padding: 0;
        overflow: hidden;
    }

    .p-inputgroupaddon .p-button {
        border-radius: 0;
    }

    .p-inputgroup > .p-component,
    .p-inputgroup > .p-inputwrapper > .p-component,
    .p-inputgroup > .p-iconfield > .p-component,
    .p-inputgroup > .p-floatlabel > .p-component,
    .p-inputgroup > .p-floatlabel > .p-inputwrapper > .p-component,
    .p-inputgroup > .p-iftalabel > .p-component,
    .p-inputgroup > .p-iftalabel > .p-inputwrapper > .p-component {
        border-radius: 0;
        margin: 0;
    }

    .p-inputgroupaddon:first-child,
    .p-inputgroup > .p-component:first-child,
    .p-inputgroup > .p-inputwrapper:first-child > .p-component,
    .p-inputgroup > .p-iconfield:first-child > .p-component,
    .p-inputgroup > .p-floatlabel:first-child > .p-component,
    .p-inputgroup > .p-floatlabel:first-child > .p-inputwrapper > .p-component,
    .p-inputgroup > .p-iftalabel:first-child > .p-component,
    .p-inputgroup > .p-iftalabel:first-child > .p-inputwrapper > .p-component {
        border-start-start-radius: dt('inputgroup.addon.border.radius');
        border-end-start-radius: dt('inputgroup.addon.border.radius');
    }

    .p-inputgroupaddon:last-child,
    .p-inputgroup > .p-component:last-child,
    .p-inputgroup > .p-inputwrapper:last-child > .p-component,
    .p-inputgroup > .p-iconfield:last-child > .p-component,
    .p-inputgroup > .p-floatlabel:last-child > .p-component,
    .p-inputgroup > .p-floatlabel:last-child > .p-inputwrapper > .p-component,
    .p-inputgroup > .p-iftalabel:last-child > .p-component,
    .p-inputgroup > .p-iftalabel:last-child > .p-inputwrapper > .p-component {
        border-start-end-radius: dt('inputgroup.addon.border.radius');
        border-end-end-radius: dt('inputgroup.addon.border.radius');
    }

    .p-inputgroup .p-component:focus,
    .p-inputgroup .p-component.p-focus,
    .p-inputgroup .p-inputwrapper-focus,
    .p-inputgroup .p-component:focus ~ label,
    .p-inputgroup .p-component.p-focus ~ label,
    .p-inputgroup .p-inputwrapper-focus ~ label {
        z-index: 1;
    }

    .p-inputgroup > .p-button:not(.p-button-icon-only) {
        width: auto;
    }

    .p-inputgroup .p-iconfield + .p-iconfield .p-inputtext {
        border-inline-start: 0;
    }
`,L={root:"p-inputgroup"},Q=b.extend({name:"inputgroup",style:K,classes:L}),X={name:"BaseInputGroup",extends:y,style:Q,provide:function(){return{$pcInputGroup:this,$parentInstance:this}}},Z={name:"InputGroup",extends:X,inheritAttrs:!1};function nn(n,a,r,s,e,t){return o(),i("div",g({class:n.cx("root")},n.ptmi("root")),[k(n.$slots,"default")],16)}Z.render=nn;var en={root:"p-inputgroupaddon"},tn=b.extend({name:"inputgroupaddon",classes:en}),on={name:"BaseInputGroupAddon",extends:y,style:tn,provide:function(){return{$pcInputGroupAddon:this,$parentInstance:this}}},pn={name:"InputGroupAddon",extends:on,inheritAttrs:!1};function rn(n,a,r,s,e,t){return o(),i("div",g({class:n.cx("root")},n.ptmi("root")),[k(n.$slots,"default")],16)}pn.render=rn;const an={viewBox:"0 0 24 24",width:"1.2em",height:"1.2em"};function sn(n,a){return o(),i("svg",an,[...a[0]||(a[0]=[c("g",{fill:"none",stroke:"currentColor","stroke-linecap":"round","stroke-linejoin":"round","stroke-width":"2"},[c("rect",{width:"14",height:"14",x:"8",y:"8",rx:"2",ry:"2"}),c("path",{d:"M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"})],-1)])])}const ln=E({name:"lucide-copy",render:sn}),un={class:"grow"},kn=P({__name:"EditValue",props:{modelValue:{},allowEdit:{type:Boolean,default:!1},allowAdd:{type:Boolean,default:!1},allowDuplicate:{type:Boolean,default:!1},editableName:{},alignVertical:{type:Boolean,default:!1}},emits:["delete","new","duplicate","rename"],setup(n,{emit:a}){const r=n,s=a,e=x(""),t=x(0);M(()=>{e.value=r.modelValue});function V(){t.value=0,e.value=r.modelValue}function S(){e.value=e.value+" (copy)",t.value=3}function B(){e.value="",t.value=2}j(()=>r.modelValue,()=>{e.value=r.modelValue});function $(){t.value===2?s("new",e.value):t.value===3?s("duplicate",r.modelValue,e.value):s("rename",r.modelValue,e.value),t.value=0}return(w,l)=>{const A=R,N=T,u=O,C=ln,I=U,z=J,G=Y,D=H;return o(),i("form",{class:"flex flex-row",onSubmit:F($,["prevent"])},[c("div",un,[m(t)===0?k(w.$slots,"default",{key:0}):(o(),v(A,{key:1,modelValue:m(e),"onUpdate:modelValue":l[0]||(l[0]=h=>W(e)?e.value=h:null),size:"small",fluid:""},null,8,["modelValue"]))]),c("div",{class:q(["mt-auto flex gap-1 ms-1",n.alignVertical?"flex-col":"flex-row"])},[n.allowEdit&&m(t)===0?(o(),i(_,{key:0},[p(u,{size:"small",severity:"secondary",title:`Edit this ${n.editableName}.`,onClick:l[1]||(l[1]=h=>t.value=1)},{icon:d(()=>[p(N)]),_:1},8,["title"]),n.allowDuplicate?(o(),v(u,{key:0,size:"small",severity:"secondary",title:`Duplicate ${n.editableName}.`,onClick:S},{icon:d(()=>[p(C)]),_:1},8,["title"])):f("",!0),p(u,{size:"small",severity:"secondary",title:`Delete this ${n.editableName}.`,onClick:l[2]||(l[2]=h=>w.$emit("delete",n.modelValue))},{icon:d(()=>[p(I)]),_:1},8,["title"])],64)):f("",!0),n.allowAdd&&m(t)===0?(o(),v(u,{key:1,size:"small",title:`Add new ${n.editableName}.`,severity:"primary",onClick:B},{icon:d(()=>[p(z)]),_:1},8,["title"])):f("",!0),m(t)!==0?(o(),i(_,{key:2},[p(u,{size:"small",title:`Add new ${n.editableName}`,severity:"primary",onClick:$},{icon:d(()=>[p(G)]),_:1},8,["title"]),p(u,{size:"small",title:"Abort",severity:"secondary",onClick:V},{icon:d(()=>[p(D)]),_:1})],64)):f("",!0)],2)],32)}}});var dn=`
    .p-progressspinner {
        position: relative;
        margin: 0 auto;
        width: 100px;
        height: 100px;
        display: inline-block;
    }

    .p-progressspinner::before {
        content: '';
        display: block;
        padding-top: 100%;
    }

    .p-progressspinner-spin {
        height: 100%;
        transform-origin: center center;
        width: 100%;
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        right: 0;
        margin: auto;
        animation: p-progressspinner-rotate 2s linear infinite;
    }

    .p-progressspinner-circle {
        stroke-dasharray: 89, 200;
        stroke-dashoffset: 0;
        stroke: dt('progressspinner.colorOne');
        animation:
            p-progressspinner-dash 1.5s ease-in-out infinite,
            p-progressspinner-color 6s ease-in-out infinite;
        stroke-linecap: round;
    }

    @keyframes p-progressspinner-rotate {
        100% {
            transform: rotate(360deg);
        }
    }
    @keyframes p-progressspinner-dash {
        0% {
            stroke-dasharray: 1, 200;
            stroke-dashoffset: 0;
        }
        50% {
            stroke-dasharray: 89, 200;
            stroke-dashoffset: -35px;
        }
        100% {
            stroke-dasharray: 89, 200;
            stroke-dashoffset: -124px;
        }
    }
    @keyframes p-progressspinner-color {
        100%,
        0% {
            stroke: dt('progressspinner.color.one');
        }
        40% {
            stroke: dt('progressspinner.color.two');
        }
        66% {
            stroke: dt('progressspinner.color.three');
        }
        80%,
        90% {
            stroke: dt('progressspinner.color.four');
        }
    }
`,cn={root:"p-progressspinner",spin:"p-progressspinner-spin",circle:"p-progressspinner-circle"},mn=b.extend({name:"progressspinner",style:dn,classes:cn}),gn={name:"BaseProgressSpinner",extends:y,props:{strokeWidth:{type:String,default:"2"},fill:{type:String,default:"none"},animationDuration:{type:String,default:"2s"}},style:mn,provide:function(){return{$pcProgressSpinner:this,$parentInstance:this}}},fn={name:"ProgressSpinner",extends:gn,inheritAttrs:!1,computed:{svgStyle:function(){return{"animation-duration":this.animationDuration}}}},hn=["fill","stroke-width"];function vn(n,a,r,s,e,t){return o(),i("div",g({class:n.cx("root"),role:"progressbar"},n.ptmi("root")),[(o(),i("svg",g({class:n.cx("spin"),viewBox:"25 25 50 50",style:t.svgStyle},n.ptm("spin")),[c("circle",g({class:n.cx("circle"),cx:"50",cy:"50",r:"20",fill:n.fill,"stroke-width":n.strokeWidth,strokeMiterlimit:"10"},n.ptm("circle")),null,16,hn)],16))],16)}fn.render=vn;export{kn as _,pn as a,fn as b,ln as c,Z as s};
//# sourceMappingURL=index-oaW5m7VD.js.map
