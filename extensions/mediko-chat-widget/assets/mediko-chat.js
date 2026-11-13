(function(){"use strict";var Te,x,hn,Z,mn,_n,gn,je,Pe,_e,bn,We,Be,Ye,$e={},Ce=[],gt=/acit|ex(?:s|g|n|p|$)|rph|grid|ows|mnc|ntw|ine[ch]|zoo|^ord|itera/i,ge=Array.isArray;function X(e,n){for(var t in n)e[t]=n[t];return e}function Xe(e){e&&e.parentNode&&e.parentNode.removeChild(e)}function Ve(e,n,t){var r,o,a,s={};for(a in n)a=="key"?r=n[a]:a=="ref"?o=n[a]:s[a]=n[a];if(arguments.length>2&&(s.children=arguments.length>3?Te.call(arguments,2):t),typeof e=="function"&&e.defaultProps!=null)for(a in e.defaultProps)s[a]===void 0&&(s[a]=e.defaultProps[a]);return Ee(e,s,r,o,null)}function Ee(e,n,t,r,o){var a={type:e,props:n,key:t,ref:r,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:o??++hn,__i:-1,__u:0};return o==null&&x.vnode!=null&&x.vnode(a),a}function V(e){return e.children}function G(e,n){this.props=e,this.context=n}function oe(e,n){if(n==null)return e.__?oe(e.__,e.__i+1):null;for(var t;n<e.__k.length;n++)if((t=e.__k[n])!=null&&t.__e!=null)return t.__e;return typeof e.type=="function"?oe(e):null}function bt(e){if(e.__P&&e.__d){var n=e.__v,t=n.__e,r=[],o=[],a=X({},n);a.__v=n.__v+1,x.vnode&&x.vnode(a),Ge(e.__P,a,n,e.__n,e.__P.namespaceURI,32&n.__u?[t]:null,r,t??oe(n),!!(32&n.__u),o),a.__v=n.__v,a.__.__k[a.__i]=a,Tn(r,a,o),n.__e=n.__=null,a.__e!=t&&xn(a)}}function xn(e){if((e=e.__)!=null&&e.__c!=null)return e.__e=e.__c.base=null,e.__k.some(function(n){if(n!=null&&n.__e!=null)return e.__e=e.__c.base=n.__e}),xn(e)}function vn(e){(!e.__d&&(e.__d=!0)&&Z.push(e)&&!Oe.__r++||mn!=x.debounceRendering)&&((mn=x.debounceRendering)||_n)(Oe)}function Oe(){try{for(var e,n=1;Z.length;)Z.length>n&&Z.sort(gn),e=Z.shift(),n=Z.length,bt(e)}finally{Z.length=Oe.__r=0}}function kn(e,n,t,r,o,a,s,d,u,c,h){var g,l,f,y,w,T,$=r&&r.__k||Ce,v=n.length;for(u=xt(t,n,$,u,v),g=0;g<v;g++)(f=t.__k[g])!=null&&(l=f.__i!=-1&&$[f.__i]||$e,f.__i=g,T=Ge(e,f,l,o,a,s,d,u,c,h),y=f.__e,f.ref&&l.ref!=f.ref&&(l.ref&&Ke(l.ref,null,f),h.push(f.ref,f.__c||y,f)),w==null&&y!=null&&(w=y),4&f.__u?(u=yn(f,u,e),l.__e&&(l.__e=null)):typeof f.type=="function"&&T!==void 0?u=T:y&&(u=y.nextSibling),f.__u&=-7);return t.__e=w,u}function xt(e,n,t,r,o){var a,s,d,u,c,h=t.length,g=h,l=0;for(e.__k=new Array(o),a=0;a<o;a++)(s=n[a])!=null&&typeof s!="boolean"&&typeof s!="function"?(typeof s=="string"||typeof s=="number"||typeof s=="bigint"||s.constructor==String?s=e.__k[a]=Ee(null,s,null,null,null):ge(s)?s=e.__k[a]=Ee(V,{children:s},null,null,null):s.constructor===void 0&&s.__b>0?s=e.__k[a]=Ee(s.type,s.props,s.key,s.ref?s.ref:null,s.__v):e.__k[a]=s,u=a+l,s.__=e,s.__b=e.__b+1,d=null,(c=s.__i=vt(s,t,u,g))!=-1&&(g--,(d=t[c])&&(d.__u|=2)),d==null||d.__v==null?(c==-1&&(o>h?l--:o<h&&l++),typeof s.type!="function"&&(s.__u|=4)):c!=u&&(c==u-1?l--:c==u+1?l++:(c>u?l--:l++,s.__u|=4))):e.__k[a]=null;if(g)for(a=0;a<h;a++)(d=t[a])!=null&&!(2&d.__u)&&(d.__e==r&&(r=oe(d)),$n(d,d));return r}function yn(e,n,t){var r,o;if(typeof e.type=="function"){for(r=e.__k,o=0;r&&o<r.length;o++)r[o]&&(r[o].__=e,n=yn(r[o],n,t));return n}e.__e!=n&&(n&&e.type&&!n.parentNode&&(n=oe(e)),n=t.insertBefore(e.__e,n||null));do n=n&&n.nextSibling;while(n!=null&&n.nodeType==8);return n}function Re(e,n){return n=n||[],e==null||typeof e=="boolean"||(ge(e)?e.some(function(t){Re(t,n)}):n.push(e)),n}function vt(e,n,t,r){var o,a,s,d=e.key,u=e.type,c=n[t],h=c!=null&&(2&c.__u)==0;if(c===null&&d==null||h&&d==c.key&&u==c.type)return t;if(r>(h?1:0)){for(o=t-1,a=t+1;o>=0||a<n.length;)if((c=n[s=o>=0?o--:a++])!=null&&!(2&c.__u)&&d==c.key&&u==c.type)return s}return-1}function wn(e,n,t){n[0]=="-"?e.setProperty(n,t??""):e[n]=t==null?"":typeof t!="number"||gt.test(n)?t:t+"px"}function Ae(e,n,t,r,o){var a,s;e:if(n=="style")if(typeof t=="string")e.style.cssText=t;else{if(typeof r=="string"&&(e.style.cssText=r=""),r)for(n in r)t&&n in t||wn(e.style,n,"");if(t)for(n in t)r&&t[n]==r[n]||wn(e.style,n,t[n])}else if(n[0]=="o"&&n[1]=="n")a=n!=(n=n.replace(bn,"$1")),s=n.toLowerCase(),n=s in e||n=="onFocusOut"||n=="onFocusIn"?s.slice(2):n.slice(2),e.l||(e.l={}),e.l[n+a]=t,t?r?t[_e]=r[_e]:(t[_e]=We,e.addEventListener(n,a?Ye:Be,a)):e.removeEventListener(n,a?Ye:Be,a);else{if(o=="http://www.w3.org/2000/svg")n=n.replace(/xlink(H|:h)/,"h").replace(/sName$/,"s");else if(n!="width"&&n!="height"&&n!="href"&&n!="list"&&n!="form"&&n!="tabIndex"&&n!="download"&&n!="rowSpan"&&n!="colSpan"&&n!="role"&&n!="popover"&&n in e)try{e[n]=t??"";break e}catch{}typeof t=="function"||(t==null||t===!1&&n[4]!="-"?e.removeAttribute(n):e.setAttribute(n,n=="popover"&&t==1?"":t))}}function Nn(e){return function(n){if(this.l){var t=this.l[n.type+e];if(n[Pe]==null)n[Pe]=We++;else if(n[Pe]<t[_e])return;return t(x.event?x.event(n):n)}}}function Ge(e,n,t,r,o,a,s,d,u,c){var h,g,l,f,y,w,T,$,v,N,I,H,P,z,M,q,C=n.type;if(n.constructor!==void 0)return null;128&t.__u&&(u=!!(32&t.__u),a=[d=n.__e=t.__e]),(h=x.__b)&&h(n);e:if(typeof C=="function"){g=s.length;try{if(v=n.props,N=C.prototype&&C.prototype.render,I=(h=C.contextType)&&r[h.__c],H=h?I?I.props.value:h.__:r,t.__c?$=(l=n.__c=t.__c).__=l.__E:(N?n.__c=l=new C(v,H):(n.__c=l=new G(v,H),l.constructor=C,l.render=yt),I&&I.sub(l),l.state||(l.state={}),l.__n=r,f=l.__d=!0,l.__h=[],l._sb=[]),N&&l.__s==null&&(l.__s=l.state),N&&C.getDerivedStateFromProps!=null&&(l.__s==l.state&&(l.__s=X({},l.__s)),X(l.__s,C.getDerivedStateFromProps(v,l.__s))),y=l.props,w=l.state,l.__v=n,f)N&&C.getDerivedStateFromProps==null&&l.componentWillMount!=null&&l.componentWillMount(),N&&l.componentDidMount!=null&&l.__h.push(l.componentDidMount);else{if(N&&C.getDerivedStateFromProps==null&&v!==y&&l.componentWillReceiveProps!=null&&l.componentWillReceiveProps(v,H),n.__v==t.__v||!l.__e&&l.shouldComponentUpdate!=null&&l.shouldComponentUpdate(v,l.__s,H)===!1){n.__v!=t.__v&&(l.props=v,l.state=l.__s,l.__d=!1),n.__e=t.__e,n.__k=t.__k,n.__k.some(function(D){D&&(D.__=n)}),Ce.push.apply(l.__h,l._sb),l._sb=[],l.__h.length&&s.push(l),d=oe(t);break e}l.componentWillUpdate!=null&&l.componentWillUpdate(v,l.__s,H),N&&l.componentDidUpdate!=null&&l.__h.push(function(){l.componentDidUpdate(y,w,T)})}if(l.context=H,l.props=v,l.__P=e,l.__e=!1,P=x.__r,z=0,N)l.state=l.__s,l.__d=!1,P&&P(n),h=l.render(l.props,l.state,l.context),Ce.push.apply(l.__h,l._sb),l._sb=[];else do l.__d=!1,P&&P(n),h=l.render(l.props,l.state,l.context),l.state=l.__s;while(l.__d&&++z<25);l.state=l.__s,l.getChildContext!=null&&(r=X(X({},r),l.getChildContext())),N&&!f&&l.getSnapshotBeforeUpdate!=null&&(T=l.getSnapshotBeforeUpdate(y,w)),M=h!=null&&h.type===V&&h.key==null?Pn(h.props.children):h,d=kn(e,ge(M)?M:[M],n,t,r,o,a,s,d,u,c),l.base=n.__e,n.__u&=-161,l.__h.length&&s.push(l),$&&(l.__E=l.__=null)}catch(D){if(s.length=g,n.__v=null,u||a!=null){if(D.then){for(n.__u|=u?160:128;d&&d.nodeType==8&&d.nextSibling;)d=d.nextSibling;a!=null&&(a[a.indexOf(d)]=null),n.__e=d}else if(a!=null)for(q=a.length;q--;)Xe(a[q])}else n.__e=t.__e;n.__k==null&&(n.__k=t.__k||[]),D.then||Sn(n),x.__e(D,n,t)}}else a==null&&n.__v==t.__v?(n.__k=t.__k,n.__e=t.__e):d=n.__e=kt(t.__e,n,t,r,o,a,s,u,c);return(h=x.diffed)&&h(n),128&n.__u?void 0:d}function Sn(e){e&&(e.__c&&(e.__c.__e=!0),e.__k&&e.__k.some(Sn))}function Tn(e,n,t){for(var r=0;r<t.length;r++)Ke(t[r],t[++r],t[++r]);x.__c&&x.__c(n,e),e.some(function(o){try{e=o.__h,o.__h=[],e.some(function(a){a.call(o)})}catch(a){x.__e(a,o.__v)}})}function Pn(e){return typeof e!="object"||e==null||e.__b>0?e:ge(e)?e.map(Pn):e.constructor!==void 0?null:X({},e)}function kt(e,n,t,r,o,a,s,d,u){var c,h,g,l,f,y,w,T=t.props||$e,$=n.props,v=n.type;if(v=="svg"?o="http://www.w3.org/2000/svg":v=="math"?o="http://www.w3.org/1998/Math/MathML":o||(o="http://www.w3.org/1999/xhtml"),a!=null){for(c=0;c<a.length;c++)if((f=a[c])&&"setAttribute"in f==!!v&&(v?f.localName==v:f.nodeType==3)){e=f,a[c]=null;break}}if(e==null){if(v==null)return document.createTextNode($);e=document.createElementNS(o,v,$.is&&$),d&&(x.__m&&x.__m(n,a),d=!1),a=null}if(v==null)T===$||d&&e.data==$||(e.data=$);else{if(a=v=="textarea"&&$.defaultValue!=null?null:a&&Te.call(e.childNodes),!d&&a!=null)for(T={},c=0;c<e.attributes.length;c++)T[(f=e.attributes[c]).name]=f.value;for(c in T)f=T[c],c=="dangerouslySetInnerHTML"?g=f:c=="children"||c in $||c=="value"&&"defaultValue"in $||c=="checked"&&"defaultChecked"in $||Ae(e,c,null,f,o);for(c in $)f=$[c],c=="children"?l=f:c=="dangerouslySetInnerHTML"?h=f:c=="value"?y=f:c=="checked"?w=f:d&&typeof f!="function"||T[c]===f||Ae(e,c,f,T[c],o);if(h)d||g&&(h.__html==g.__html||h.__html==e.innerHTML)||(e.innerHTML=h.__html),n.__k=[];else if(g&&(e.innerHTML=""),kn(n.type=="template"?e.content:e,ge(l)?l:[l],n,t,r,v=="foreignObject"?"http://www.w3.org/1999/xhtml":o,a,s,a?a[0]:t.__k&&oe(t,0),d,u),a!=null)for(c=a.length;c--;)Xe(a[c]);d&&v!="textarea"||(c="value",v=="progress"&&y==null?e.removeAttribute("value"):y!=null&&(y!==e[c]||v=="progress"&&!y||v=="option"&&y!=T[c])&&Ae(e,c,y,T[c],o),c="checked",w!=null&&w!=e[c]&&Ae(e,c,w,T[c],o))}return e}function Ke(e,n,t){try{if(typeof e=="function"){var r=typeof e.__u=="function";r&&e.__u(),r&&n==null||(e.__u=e(n))}else e.current=n}catch(o){x.__e(o,t)}}function $n(e,n,t){var r,o;if(x.unmount&&x.unmount(e),(r=e.ref)&&(r.current&&r.current!=e.__e||Ke(r,null,n)),(r=e.__c)!=null){if(r.componentWillUnmount)try{r.componentWillUnmount()}catch(a){x.__e(a,n)}r.base=r.__P=r.__n=null}if(r=e.__k)for(o=0;o<r.length;o++)r[o]&&$n(r[o],n,t||typeof e.type!="function");t||Xe(e.__e),e.__c=e.__=e.__e=void 0}function yt(e,n,t){return this.constructor(e,t)}function Cn(e,n,t){var r,o,a,s;n==document&&(n=document.documentElement),x.__&&x.__(e,n),o=(r=!1)?null:n.__k,a=[],s=[],Ge(n,e=n.__k=Ve(V,null,[e]),o||$e,$e,n.namespaceURI,o?null:n.firstChild?Te.call(n.childNodes):null,a,o?o.__e:n.firstChild,r,s),Tn(a,e,s),e.props.children=null}Te=Ce.slice,x={__e:function(e,n,t,r){for(var o,a,s;n=n.__;)if((o=n.__c)&&!o.__)try{if((a=o.constructor)&&a.getDerivedStateFromError!=null&&(o.setState(a.getDerivedStateFromError(e)),s=o.__d),o.componentDidCatch!=null&&(o.componentDidCatch(e,r||{}),s=o.__d),s)return o.__E=o}catch(d){e=d}throw e}},hn=0,G.prototype.setState=function(e,n){var t;t=this.__s!=null&&this.__s!=this.state?this.__s:this.__s=X({},this.state),typeof e=="function"&&(e=e(X({},t),this.props)),e&&X(t,e),e!=null&&this.__v&&(n&&this._sb.push(n),vn(this))},G.prototype.forceUpdate=function(e){this.__v&&(this.__e=!0,e&&this.__h.push(e),vn(this))},G.prototype.render=V,Z=[],_n=typeof Promise=="function"?Promise.prototype.then.bind(Promise.resolve()):setTimeout,gn=function(e,n){return e.__v.__b-n.__v.__b},Oe.__r=0,je=Math.random().toString(8),Pe="__d"+je,_e="__a"+je,bn=/(PointerCapture)$|Capture$/i,We=0,Be=Nn(!1),Ye=Nn(!0);var wt=0;function i(e,n,t,r,o,a){n||(n={});var s,d,u=n;if("ref"in u)for(d in u={},n)d=="ref"?s=n[d]:u[d]=n[d];var c={type:e,props:u,key:t,ref:s,__k:null,__:null,__b:0,__e:null,__c:null,constructor:void 0,__v:--wt,__i:-1,__u:0,__source:o,__self:a};if(typeof e=="function"&&(s=e.defaultProps))for(d in s)u[d]===void 0&&(u[d]=s[d]);return x.vnode&&x.vnode(c),c}var de,O,Je,En,be=0,On=[],R=x,Rn=R.__b,An=R.__r,In=R.diffed,zn=R.__c,Mn=R.unmount,Ln=R.__;function Ie(e,n){R.__h&&R.__h(O,e,be||n),be=0;var t=O.__H||(O.__H={__:[],__h:[]});return e>=t.__.length&&t.__.push({}),t.__[e]}function k(e){return be=1,Nt(Un,e)}function Nt(e,n,t){var r=Ie(de++,2);if(r.t=e,!r.__c&&(r.__=[t?t(n):Un(void 0,n),function(d){var u=r.__N?r.__N[0]:r.__[0],c=r.t(u,d);u!==c&&(r.__N=[c,r.__[1]],r.__c.setState({}))}],r.__c=O,!O.__f)){var o=function(d,u,c){if(!r.__c.__H)return!0;var h=!1,g=r.__c.props!==d;if(r.__c.__H.__.some(function(f){if(f.__N){h=!0;var y=f.__[0];f.__=f.__N,f.__N=void 0,y!==f.__[0]&&(g=!0)}}),a){var l=a.call(this,d,u,c);return h?l||g:l}return!h||g};O.__f=!0;var a=O.shouldComponentUpdate,s=O.componentWillUpdate;O.componentWillUpdate=function(d,u,c){if(this.__e){var h=a;a=void 0,o(d,u,c),a=h}s&&s.call(this,d,u,c)},O.shouldComponentUpdate=o}return r.__N||r.__}function K(e,n){var t=Ie(de++,3);!R.__s&&Ze(t.__H,n)&&(t.__=e,t.u=n,O.__H.__h.push(t))}function St(e,n){var t=Ie(de++,4);!R.__s&&Ze(t.__H,n)&&(t.__=e,t.u=n,O.__h.push(t))}function L(e){return be=5,Hn(function(){return{current:e}},[])}function Hn(e,n){var t=Ie(de++,7);return Ze(t.__H,n)&&(t.__=e(),t.__H=n,t.__h=e),t.__}function xe(e,n){return be=8,Hn(function(){return e},n)}function Tt(){for(var e;e=On.shift();){var n=e.__H;if(e.__P&&n)try{n.__h.some(ze),n.__h.some(qe),n.__h=[]}catch(t){n.__h=[],R.__e(t,e.__v)}}}R.__b=function(e){O=null,Rn&&Rn(e)},R.__=function(e,n){e&&n.__k&&n.__k.__m&&(e.__m=n.__k.__m),Ln&&Ln(e,n)},R.__r=function(e){An&&An(e),de=0;var n=(O=e.__c).__H;n&&(Je===O?(n.__h=[],O.__h=[],n.__.some(function(t){t.__N&&(t.__=t.__N),t.u=t.__N=void 0})):(n.__h.some(ze),n.__h.some(qe),n.__h=[],de=0)),Je=O},R.diffed=function(e){In&&In(e);var n=e.__c;n&&n.__H&&(n.__H.__h.length&&(On.push(n)!==1&&En===R.requestAnimationFrame||((En=R.requestAnimationFrame)||Pt)(Tt)),n.__H.__.some(function(t){t.u&&(t.__H=t.u,t.u=void 0)})),Je=O=null},R.__c=function(e,n){n.some(function(t){try{t.__h.some(ze),t.__h=t.__h.filter(function(r){return!r.__||qe(r)})}catch(r){n.some(function(o){o.__h&&(o.__h=[])}),n=[],R.__e(r,t.__v)}}),zn&&zn(e,n)},R.unmount=function(e){Mn&&Mn(e);var n,t=e.__c;t&&t.__H&&(t.__H.__.some(function(r){try{ze(r)}catch(o){n=o}}),t.__H=void 0,n&&R.__e(n,t.__v))};var Dn=typeof requestAnimationFrame=="function";function Pt(e){var n,t=function(){clearTimeout(r),Dn&&cancelAnimationFrame(n),setTimeout(e)},r=setTimeout(t,35);Dn&&(n=requestAnimationFrame(t))}function ze(e){var n=O,t=e.__c;typeof t=="function"&&(e.__c=void 0,t()),O=n}function qe(e){var n=O;e.__c=e.__(),O=n}function Ze(e,n){return!e||e.length!==n.length||n.some(function(t,r){return t!==e[r]})}function Un(e,n){return typeof n=="function"?n(e):n}function $t(e,n){for(var t in n)e[t]=n[t];return e}function Fn(e,n){for(var t in e)if(t!=="__source"&&!(t in n))return!0;for(var r in n)if(r!=="__source"&&e[r]!==n[r])return!0;return!1}function jn(e,n){this.props=e,this.context=n}(jn.prototype=new G).isPureReactComponent=!0,jn.prototype.shouldComponentUpdate=function(e,n){return Fn(this.props,e)||Fn(this.state,n)};var Wn=x.__b;x.__b=function(e){e.type&&e.type.__f&&e.ref&&(e.props.ref=e.ref,e.ref=null),Wn&&Wn(e)};var Ct=x.__e;x.__e=function(e,n,t,r){if(e.then){for(var o,a=n;a=a.__;)if((o=a.__c)&&o.__c)return n.__e==null&&(n.__e=t.__e,n.__k=t.__k||[]),o.__c(e,n)}Ct(e,n,t,r)};var Bn=x.unmount;function Yn(e,n,t){return e&&(e.__c&&e.__c.__H&&(e.__c.__H.__.forEach(function(r){typeof r.__c=="function"&&r.__c()}),e.__c.__H=null),(e=$t({},e)).__c!=null&&(e.__c.__P===t&&(e.__c.__P=n),e.__c.__e=!0,e.__c=null),e.__k=e.__k&&e.__k.map(function(r){return Yn(r,n,t)})),e}function Xn(e,n,t){return e&&t&&(e.__v=null,e.__k=e.__k&&e.__k.map(function(r){return Xn(r,n,t)}),e.__c&&e.__c.__P===n&&(e.__e&&t.appendChild(e.__e),e.__c.__e=!0,e.__c.__P=t)),e}function Qe(){this.__u=0,this.o=null,this.__b=null}function Vn(e){var n=e.__&&e.__.__c;return n&&n.__a&&n.__a(e)}function Me(){this.i=null,this.l=null}x.unmount=function(e){var n=e.__c;n&&(n.__z=!0),n&&n.__R&&n.__R(),n&&32&e.__u&&(e.type=null),Bn&&Bn(e)},(Qe.prototype=new G).__c=function(e,n){var t=n.__c,r=this;r.o==null&&(r.o=[]),r.o.push(t);var o=Vn(r.__v),a=!1,s=function(){a||r.__z||(a=!0,t.__R=null,o?o(u):u())};t.__R=s;var d=t.__P;t.__P=null;var u=function(){if(!--r.__u){if(r.state.__a){var c=r.state.__a;r.__v.__k[0]=Xn(c,c.__c.__P,c.__c.__O)}var h;for(r.setState({__a:r.__b=null});h=r.o.pop();)h.__P=d,h.forceUpdate()}};r.__u++||32&n.__u||r.setState({__a:r.__b=r.__v.__k[0]}),e.then(s,s)},Qe.prototype.componentWillUnmount=function(){this.o=[]},Qe.prototype.render=function(e,n){if(this.__b){if(this.__v.__k){var t=document.createElement("div"),r=this.__v.__k[0].__c;this.__v.__k[0]=Yn(this.__b,t,r.__O=r.__P)}this.__b=null}var o=n.__a&&Ve(V,null,e.fallback);return o&&(o.__u&=-33),[Ve(V,null,n.__a?null:e.children),o]};var Gn=function(e,n,t){if(++t[1]===t[0]&&e.l.delete(n),e.props.revealOrder&&(e.props.revealOrder[0]!=="t"||!e.l.size))for(t=e.i;t;){for(;t.length>3;)t.pop()();if(t[1]<t[0])break;e.i=t=t[2]}};(Me.prototype=new G).__a=function(e){var n=this,t=Vn(n.__v),r=n.l.get(e);return r[0]++,function(o){var a=function(){n.props.revealOrder?(r.push(o),Gn(n,e,r)):o()};t?t(a):a()}},Me.prototype.render=function(e){this.i=null,this.l=new Map;var n=Re(e.children);e.revealOrder&&e.revealOrder[0]==="b"&&n.reverse();for(var t=n.length;t--;)this.l.set(n[t],this.i=[1,0,this.i]);return e.children},Me.prototype.componentDidUpdate=Me.prototype.componentDidMount=function(){var e=this;this.l.forEach(function(n,t){Gn(e,t,n)})};var Et=typeof Symbol<"u"&&Symbol.for&&Symbol.for("react.element")||60103,Ot=/^(?:accent|alignment|arabic|baseline|cap|clip(?!PathU)|color|dominant|fill|flood|font|glyph(?!R)|horiz|image(!S)|letter|lighting|marker(?!H|W|U)|overline|paint|pointer|shape|stop|strikethrough|stroke|text(?!L)|transform|underline|unicode|units|v|vector|vert|word|writing|x(?!C))[A-Z]/,Rt=/^on(Ani|Tra|Tou|BeforeInp|Compo)/,At=/[A-Z0-9]/g,It=typeof document<"u",zt=function(e){return(typeof Symbol<"u"&&typeof Symbol()=="symbol"?/fil|che|rad/:/fil|che|ra/).test(e)};function Mt(e,n,t){return n.__k==null&&(n.textContent=""),Cn(e,n),typeof t=="function"&&t(),e?e.__c:null}G.prototype.isReactComponent=!0,["componentWillMount","componentWillReceiveProps","componentWillUpdate"].forEach(function(e){Object.defineProperty(G.prototype,e,{configurable:!0,get:function(){return this["UNSAFE_"+e]},set:function(n){Object.defineProperty(this,e,{configurable:!0,writable:!0,value:n})}})});var Kn=x.event;x.event=function(e){return Kn&&(e=Kn(e)),e.persist=function(){},e.isPropagationStopped=function(){return this.cancelBubble},e.isDefaultPrevented=function(){return this.defaultPrevented},e.nativeEvent=e};var Lt={configurable:!0,get:function(){return this.class}},Jn=x.vnode;x.vnode=function(e){typeof e.type=="string"&&function(n){var t=n.props,r=n.type,o={},a=r.indexOf("-")==-1;for(var s in t){var d=t[s];if(!(s==="value"&&"defaultValue"in t&&d==null||It&&s==="children"&&r==="noscript"||s==="class"||s==="className")){var u=s.toLowerCase();s==="defaultValue"&&"value"in t&&t.value==null?s="value":s==="download"&&d===!0?d="":u==="translate"&&d==="no"?d=!1:u[0]==="o"&&u[1]==="n"?u==="ondoubleclick"?s="ondblclick":u!=="onchange"||r!=="input"&&r!=="textarea"||zt(t.type)?u==="onfocus"?s="onfocusin":u==="onblur"?s="onfocusout":Rt.test(s)&&(s=u):u=s="oninput":a&&Ot.test(s)?s=s.replace(At,"-$&").toLowerCase():d===null&&(d=void 0),u==="oninput"&&o[s=u]&&(s="oninputCapture"),o[s]=d}}r=="select"&&(o.multiple&&Array.isArray(o.value)&&(o.value=Re(t.children).forEach(function(c){c.props.selected=o.value.indexOf(c.props.value)!=-1})),o.defaultValue!=null&&(o.value=Re(t.children).forEach(function(c){c.props.selected=o.multiple?o.defaultValue.indexOf(c.props.value)!=-1:o.defaultValue==c.props.value}))),t.class&&!t.className?(o.class=t.class,Object.defineProperty(o,"className",Lt)):t.className&&(o.class=o.className=t.className),n.props=o}(e),e.$$typeof=Et,Jn&&Jn(e)};var qn=x.__r;x.__r=function(e){qn&&qn(e),e.__c};var Zn=x.diffed;x.diffed=function(e){Zn&&Zn(e);var n=e.props,t=e.__e;t!=null&&e.type==="textarea"&&"value"in n&&n.value!==t.value&&(t.value=n.value==null?"":n.value)};function Ht(e){return!!e.__k&&(Cn(null,e),!0)}function Dt(e){return{render:function(n){Mt(n,e)},unmount:function(){Ht(e)}}}const Ut=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,Ft=/^(\+639|09)\d{9}$/,en={name:"Please enter your name.",email:"Please enter a valid email.",phone:"Please enter a valid mobile number (09XXXXXXXXX)."};function jt({name:e,email:n,phone:t}={}){const r=String(e??"").trim(),o=String(n??"").trim(),a=String(t??"").replace(/[\s-]/g,""),s={};return(r.length<1||r.length>100)&&(s.name=en.name),Ut.test(o)||(s.email=en.email),Ft.test(a)||(s.phone=en.phone),Object.keys(s).length?{ok:!1,errors:s}:{ok:!0,value:{customerName:r,customerEmail:o,customerPhone:a}}}function Wt(e){try{const n=new URLSearchParams(e||"").get("mdk_chat");return n||null}catch{return null}}const Bt="https://cdn.shopify.com/";function Qn(e){if(!e||typeof e!="object")return null;let n;try{n=new URL(String(e.url))}catch{return null}if(n.protocol!=="https:"||typeof e.title!="string"||!e.title.trim())return null;const t=typeof e.image=="string"&&e.image.startsWith(Bt)?e.image:null,r=typeof e.price=="string"&&/^\d+(\.\d{1,2})?$/.test(e.price)?e.price:null,o=typeof e.currency=="string"&&/^[A-Z]{3}$/.test(e.currency)?e.currency:null;return{url:String(e.url),title:e.title.slice(0,200),image:t,price:r,currency:o}}function Yt(e,n){if(!e)return"";const t=Number(e);if(!Number.isFinite(t))return"";const r=t.toLocaleString("en-PH",{minimumFractionDigits:2,maximumFractionDigits:2});return!n||n==="PHP"?`₱${r}`:`${n} ${r}`}const Xt=/^[a-z0-9][a-z0-9-]*$/i,Vt=/https:\/\/[^\s<>"]+/gi;function nn(e,n){for(const t of String(e||"").matchAll(Vt)){const r=t[0].replace(/[.,!?;:)'"]+$/,"");let o;try{o=new URL(r)}catch{continue}if(o.host!==n)continue;const a=/\/products\/([^/?#]+)\/?$/.exec(o.pathname);if(a&&Xt.test(a[1]))return{url:r,handle:a[1]}}return null}function Gt(e){return`/products/${encodeURIComponent(e)}.js`}function Kt(e,n,t="PHP"){if(!e||typeof e.title!="string")return null;let r=typeof e.featured_image=="string"?e.featured_image:null;r&&r.startsWith("//")&&(r=`https:${r}`);const o=Number(e.price);return Qn({url:n,title:e.title,image:r,price:Number.isFinite(o)?(o/100).toFixed(2):null,currency:t})}function et(e){if(!e)return new Date().toISOString();const n=String(e);return/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(n)?n.replace(" ","T")+"Z":n}function Jt(e){return typeof e=="string"&&e.startsWith("[Agent] ")?e.slice(8):e}function nt(e){const n=e.role==="agent"||e.role==="assistant";return{id:e.id,role:n?"agent":"user",content:n?Jt(e.content):e.content,ts:et(e.created_at),preview:n?Qn(e.preview):null,hidePreview:!n&&e.hidePreview===!0}}function qt(e,n){const t=new Set(e.map(o=>o.id)),r=n.map(nt).filter(o=>!t.has(o.id));return r.length?[...e,...r]:e}function Zt(e,n,t){return t!=null&&t.id?e.some(r=>r.id===t.id)?e.filter(r=>r.id!==n):e.map(r=>r.id===n?{...r,id:t.id,ts:et(t.created_at)}:r):e}function Qt(e){return e===404}const er="This chat has ended. Fill in the form to start a new one.",J="https://mediko-chatbot.quailshack.com/",tn="Kumusta po! Paano ko kayo matutulungan ngayon? 😊",ve="mediko_session_id",nr="mdk_chat",tr=3e3,rr=5*60*1e3,ke="Something went wrong. Please try again.",ue="Can’t connect. Retrying…",Q={credentials:"omit",mode:"cors"},tt=[3e3,1e4,3e4],or=5e3,ar=8e3,ir=15e3;function rn(){return`msg-${Date.now()}-${Math.random().toString(36).slice(2)}`}function ae(e,n={},t=ar){const r=new AbortController,o=setTimeout(()=>r.abort(),t);return fetch(e,{...n,signal:r.signal}).finally(()=>clearTimeout(o))}async function on(e,n){try{const t=await e.json();return(t==null?void 0:t.error)||n}catch{return n}}function sr(){const[e,n]=k([]),[t,r]=k(!1),[o,a]=k(!1),[s,d]=k(null),[u,c]=k(!1),[h,g]=k(!1),[l,f]=k(null),[y,w]=k(null),[T,$]=k(null),[v,N]=k(null),[I,H]=k(!1),[P,z]=k(!1),[M,q]=k(!1),C=L(null),D=L(!1),pe=L(null),ee=L(null),De=L(!1),ie=L(null),Ue=L(0),fe=L(!1),ne=L(null),ye=L(0),se=L(null),le=L(!1),ce=L(null),te=xe((p,_,b={})=>{n(S=>[...S,{id:rn(),role:p,content:_,ts:new Date().toISOString(),...b}])},[]),we=xe(p=>{n(_=>qt(_,p))},[]);K(()=>{if(De.current)return;De.current=!0,Ne(),un();const p=setInterval(Ne,rr);return()=>{clearInterval(p),clearTimeout(se.current),mt(),pn(),clearTimeout(ie.current)}},[]);async function Ne(){clearTimeout(se.current);let p=!1;try{const _=await ae(`${J}/api/chat/config`,Q);if(_.ok){const b=await _.json();D.current=b.aiEnabled===!0,f(typeof b.online=="boolean"?b.online:null),w(b.nextOpenAt||null),$(b.schedule||null),p=!0}}catch{}p?(le.current&&(le.current=!1,N(_=>_===ue?null:_),C.current&&A(C.current)),q(!1)):(le.current=!0,q(!0),se.current=setTimeout(Ne,ir))}async function un(){let p=null;const _=Wt(location.search);if(_)try{const S=await ae(`${J}/api/chat/resume?t=${encodeURIComponent(_)}`,Q);if(S.ok){const E=await S.json();if(E!=null&&E.sessionId){p=E.sessionId;try{localStorage.setItem(ve,p)}catch{}H(!0),Se()}}else S.status===410&&Se()}catch{}if(!p)try{p=localStorage.getItem(ve)}catch{}const b=p?await m(p):"gone";if(b==="gone"){if(p)try{localStorage.removeItem(ve)}catch{}c(!0)}else ft(p),b==="error"&&(N(ue),F(p));g(!0)}function Se(){try{const p=new URL(location.href);p.searchParams.delete(nr),history.replaceState(history.state,"",p.pathname+p.search+p.hash)}catch{}}async function he(p){let _=null;try{const b=await ae(`${J}/api/chat/history/${p}`,Q);if(_=b.status,b.ok){const{messages:S=[]}=await b.json();return{outcome:"ok",rows:S}}}catch{}return{outcome:Qt(_)?"gone":"error",rows:[]}}async function m(p){const{outcome:_,rows:b}=await he(p);return _==="ok"&&(n(b.map(nt)),b.length||te("agent",tn)),_}async function A(p){const{outcome:_,rows:b}=await he(p);return C.current!==p||(_==="ok"?(pn(),N(S=>S===ue?null:S),b.length?we(b):n(S=>S.length?S:[{id:rn(),role:"agent",content:tn,ts:new Date().toISOString()}])):_==="gone"&&fn()),_}function F(p){clearTimeout(ne.current);const _=tt[Math.min(ye.current,tt.length-1)];ye.current+=1,ne.current=setTimeout(async()=>{C.current===p&&await A(p)==="error"&&C.current===p&&F(p)},_)}function pn(){clearTimeout(ne.current),ne.current=null,ye.current=0}function ft(p){C.current=p,d(p),c(!1),ht(p)}const Dr=xe(async p=>{if(P)return{ok:!1};z(!0),N(null);try{const _=await ae(`${J}/api/chat/session`,{...Q,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...p,metadata:{url:location.href}})});if(!_.ok)return{ok:!1,error:_.status===400?await on(_,ke):ue};const{sessionId:b}=await _.json();try{localStorage.setItem(ve,b)}catch{}return n([]),te("agent",tn),ft(b),{ok:!0}}catch{return{ok:!1,error:ue}}finally{z(!1)}},[P,te]);function ht(p,_=!1){if(ee.current)return;const b=new EventSource(`${J}/api/chat/listen/${p}`);ee.current=b,b.onmessage=S=>{var Y;let E;try{E=JSON.parse(S.data)}catch{return}switch(E.type){case"connected":{(_||ne.current)&&A(p),_=!0;break}case"agent_message":{a(!1),clearTimeout(ie.current),(Y=E.message)!=null&&Y.content&&we([{...E.message,role:"agent"}]);break}case"agent_typing":{clearTimeout(ie.current),a(!!E.value),E.value&&(ie.current=setTimeout(()=>a(!1),8e3));break}}},b.onerror=()=>{b.readyState===EventSource.CLOSED&&(ee.current===b&&(ee.current=null),clearTimeout(ce.current),ce.current=setTimeout(async()=>{C.current===p&&await A(p)!=="gone"&&C.current===p&&ht(p,!0)},or))}}function mt(){var p;clearTimeout(ce.current);try{(p=ee.current)==null||p.close()}catch{}ee.current=null}const Ur=xe(()=>{const p=C.current;if(!p)return;const _=Date.now();_-Ue.current<tr||(Ue.current=_,ae(`${J}/api/chat/typing`,{...Q,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:p})}).catch(()=>{}))},[]),Fr=xe(async(p,{hidePreview:_=!1}={})=>{const b=C.current;if(!p.trim()||t||!b)return;if(N(null),D.current===!0)return jr(b,p);const S=rn();n(E=>[...E,{id:S,role:"user",content:p,ts:new Date().toISOString(),hidePreview:_}]);try{const E=await ae(`${J}/api/chat/message`,{...Q,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:b,message:p,..._&&{hidePreview:!0}})});if(E.status===404){n(re=>re.filter(me=>me.id!==S)),fn(),N(er);return}if(!E.ok){n(re=>re.filter(me=>me.id!==S)),N(await on(E,ke));return}const{message:Y,away:Fe}=await E.json();n(re=>Zt(re,S,Y)),Fe&&!fe.current&&(fe.current=!0,te("agent",Fe))}catch{n(E=>E.filter(Y=>Y.id!==S)),N(ke)}},[t,te]);async function jr(p,_){var me;te("user",_),r(!0),(me=pe.current)==null||me.abort(),pe.current=new AbortController;const b=`msg-${Date.now()}`;let S=!1,E="";function Y(){S||(S=!0,r(!1),n(U=>[...U,{id:b,role:"assistant",content:"",ts:new Date().toISOString()}]))}function Fe(U){n(j=>j.map(B=>B.id===b?{...B,content:U}:B))}function re(U){if(!U.startsWith("data: "))return;let j;try{j=JSON.parse(U.slice(6))}catch{return}switch(j.type){case"chunk":Y(),E+=j.text,n(B=>B.map(W=>W.id===b?{...W,content:W.content+j.text}:W));break;case"done":Y(),r(!1);break;case"handoff":case"agent_mode":case"away":Y(),r(!1),Fe(j.message);break;case"agent_ack":r(!1);break;case"error":r(!1),S&&n(B=>B.filter(W=>W.id!==b)),N(j.message);break}}try{const U=await fetch(`${J}/api/chat`,{...Q,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({message:_,sessionId:p}),signal:pe.current.signal});if(!U.ok)throw new Error(`HTTP ${U.status}`);if(!U.body)throw new Error("no body");const j=U.body.getReader(),B=new TextDecoder;let W="";for(;;){const{done:Yr,value:Xr}=await j.read();if(Yr){W.trim()&&re(W.trim());break}W+=B.decode(Xr,{stream:!0});const _t=W.split(/\n\n/);W=_t.pop();for(const Vr of _t)for(const Gr of Vr.split(`
`))re(Gr)}}catch(U){if(U.name==="AbortError")return;r(!1),S&&!E&&n(j=>j.filter(B=>B.id!==b)),N(ke)}}function fn(){var p;try{localStorage.removeItem(ve)}catch{}C.current=null,(p=pe.current)==null||p.abort(),mt(),pn(),clearTimeout(ie.current),n([]),d(null),a(!1),r(!1),c(!0)}async function Wr({order:p,contact:_}){try{const b=await ae(`${J}/api/chat/order-status`,{...Q,method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({order:p,contact:_})});if(b.ok){const S=await b.json();return{ok:!0,found:S.found===!0,status:S.status||null}}return{ok:!1,error:await on(b,ke)}}catch{return{ok:!1,error:ue}}}function Br(){fn(),N(null)}return{messages:e,isTyping:t,agentTyping:o,needsPrechat:u,ready:h,online:l,nextOpenAt:y,schedule:T,error:v,sessionId:s,autoOpen:I,starting:P,serverDown:M,startChat:Dr,sendMessage:Fr,notifyTyping:Ur,resetSession:Br,trackOrder:Wr}}const an={mon:"Mon",tue:"Tue",wed:"Wed",thu:"Thu",fri:"Fri",sat:"Sat",sun:"Sun"};function rt(e){const[n,t]=String(e).split(":").map(Number);return`${(n+11)%12+1}:${String(t).padStart(2,"0")} ${n<12?"AM":"PM"}`}function lr(e){const n=Array.isArray(e==null?void 0:e.days)?e.days:[],t=[];for(const r of n){const o=r.open&&r.start&&r.end?`${rt(r.start)}–${rt(r.end)}`:"Closed",a=t[t.length-1];a&&a.hours===o?a.to=r.day:t.push({from:r.day,to:r.day,hours:o})}return t.map(r=>({days:r.from===r.to?an[r.from]:`${an[r.from]}–${an[r.to]}`,hours:r.hours}))}const cr=/^\s*(?:order\s*)?(?:no\.?\s*)?#?\s*\d{3,10}\s*$/i,dr=/^[^\s@]+@[^\s@]+\.[^\s@]+$/,ur=/^(\+639|639|09)\d{9}$/;function pr({order:e,contact:n}={}){const t=String(e||"").trim(),r=String(n||"").trim(),o={};return cr.test(t)||(o.order="Please enter your order number (e.g. #1042)."),!dr.test(r)&&!ur.test(r.replace(/[\s-]/g,""))&&(o.contact="Please enter the email or mobile number used for the order."),Object.keys(o).length?{ok:!1,errors:o}:{ok:!0,value:{order:t,contact:r}}}const ot={shipped:"Shipped",delivered:"Delivered",partially_shipped:"Partially shipped",cancelled:"Cancelled",processing:"Being prepared"};function at(e){return ot[e]||ot.processing}function Le(e){const n=e?new Date(e):null;return n&&!Number.isNaN(n.getTime())?n.toLocaleDateString("en-PH",{month:"short",day:"numeric",year:"numeric",timeZone:"Asia/Manila"}):""}function fr(e){if(!e||e.loggedIn!==!0||!Array.isArray(e.orders))return{loggedIn:!1,orders:[]};const n=r=>typeof r=="string"&&r?r:null;return{loggedIn:!0,orders:e.orders.filter(r=>r&&typeof r.order=="string"&&r.order).map(r=>({order:r.order,state:n(r.state)||"processing",placedAt:n(r.placedAt),shippedAt:n(r.shippedAt),deliveredAt:n(r.deliveredAt),carrier:n(r.carrier),trackingNumber:n(r.trackingNumber),trackingUrl:typeof r.trackingUrl=="string"&&/^https:\/\//i.test(r.trackingUrl)?r.trackingUrl:null}))}}const hr="/apps/mediko/orders",mr=8e3;async function _r(){const e=new AbortController,n=setTimeout(()=>e.abort(),mr);try{const t=await fetch(hr,{credentials:"same-origin",headers:{Accept:"application/json"},signal:e.signal});return t.ok?fr(await t.json()):{loggedIn:!1,orders:[]}}catch{return{loggedIn:!1,orders:[]}}finally{clearTimeout(n)}}function gr(){const e=typeof window<"u"?window.MEDIKO_CUSTOMER:null;return e&&(e.email||e.phone)||""}function it({s:e,onChat:n,onBack:t,backLabel:r}){return i("div",{className:"track-result",children:[i("div",{className:"track-order",children:[i("span",{className:"track-order-name",children:e.order}),i("span",{className:`track-state ${e.state}`,children:at(e.state)})]}),e.placedAt&&i("div",{className:"track-line",children:["Placed ",Le(e.placedAt)]}),e.shippedAt&&i("div",{className:"track-line",children:["Shipped ",Le(e.shippedAt),e.carrier?` via ${e.carrier}`:""]}),e.deliveredAt&&i("div",{className:"track-line",children:["Delivered ",Le(e.deliveredAt)]}),e.trackingNumber&&i("div",{className:"track-line",children:["Tracking number: ",i("b",{children:e.trackingNumber})]}),e.trackingUrl&&i("a",{className:"prechat-cta track-link",href:e.trackingUrl,target:"_blank",rel:"noopener noreferrer",children:"Track shipment"}),i("button",{className:"track-secondary",type:"button",onClick:()=>n(e.order),children:"Chat with us about this order"}),i("button",{className:"track-secondary",type:"button",onClick:t,children:r})]})}function br({trackOrder:e,onBack:n,onChat:t}){const[r,o]=k(null),[a,s]=k(null),[d,u]=k(!1),[c,h]=k(()=>({order:"",contact:gr()})),[g,l]=k({}),[f,y]=k(!1),[w,T]=k(null);K(()=>{let P=!0;return _r().then(z=>{P&&o(z)}),()=>{P=!1}},[]);const $=P=>z=>{h(M=>({...M,[P]:z.target.value})),g[P]&&l(M=>({...M,[P]:void 0}))};async function v(P){if(P.preventDefault(),f)return;const z=pr(c);if(!z.ok){l(z.errors);return}y(!0);const M=await e(z.value);y(!1),T(M.ok?{found:M.found,status:M.status}:{error:M.error})}const N=(r==null?void 0:r.loggedIn)&&r.orders.length>0,I=w!=null&&w.found?w.status:null,H=r&&!I&&!a&&(!N||d);return i("div",{className:"messages track-wrap",children:[i("div",{className:"track-head",children:[i("button",{className:"track-back",type:"button",onClick:n,children:"← Back"}),i("span",{className:"track-title",children:"Track my order"})]}),!r&&i("div",{className:"track-list","aria-busy":"true","aria-label":"Loading",children:[i("div",{className:"skeleton-bubble w70"}),i("div",{className:"skeleton-bubble w60"})]}),a&&i(it,{s:a,onChat:t,onBack:()=>s(null),backLabel:"Back to my orders"}),I&&i(it,{s:I,onChat:t,onBack:()=>T(null),backLabel:"Check another order"}),N&&!a&&!I&&!d&&i(V,{children:[i("div",{className:"track-subtitle",children:"Your recent orders"}),i("div",{className:"track-list",children:r.orders.map(P=>i("button",{type:"button",className:"track-item",onClick:()=>s(P),children:[i("span",{className:"track-item-main",children:[i("span",{className:"track-order-name",children:P.order}),P.placedAt&&i("span",{className:"track-item-date",children:Le(P.placedAt)})]}),i("span",{className:`track-state ${P.state}`,children:at(P.state)})]},P.order))}),i("button",{className:"track-secondary",type:"button",onClick:()=>u(!0),children:"Track a different order"})]}),(r==null?void 0:r.loggedIn)&&!N&&!I&&i("div",{className:"track-line",children:"No orders on your account yet. You can still look one up below."}),H&&i("form",{className:"track-form",onSubmit:v,noValidate:!0,children:[i("label",{className:"prechat-field",children:[i("span",{className:"prechat-label",children:"Order number"}),i("input",{className:`prechat-input${g.order?" invalid":""}`,type:"text",inputMode:"numeric",placeholder:"#1042",value:c.order,onChange:$("order"),"aria-invalid":!!g.order}),g.order&&i("span",{className:"prechat-error",children:g.order})]}),i("label",{className:"prechat-field",children:[i("span",{className:"prechat-label",children:"Email or mobile number used for the order"}),i("input",{className:`prechat-input${g.contact?" invalid":""}`,type:"text",autoComplete:"email",value:c.contact,onChange:$("contact"),"aria-invalid":!!g.contact}),g.contact&&i("span",{className:"prechat-error",children:g.contact})]}),(w==null?void 0:w.error)&&i("div",{className:"prechat-form-error",role:"alert",children:["⚠️ ",w.error]}),w&&!w.error&&!w.found&&i("div",{className:"prechat-form-error",role:"alert",children:"We couldn’t find an order with those details. Check the order number and the email or mobile number used at checkout."}),i("button",{className:"prechat-cta",type:"submit",disabled:f,children:f?"Checking…":"Check status"}),N&&i("button",{className:"track-secondary",type:"button",onClick:()=>u(!1),children:"Back to my orders"})]})]})}const sn=/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|https?:\/\/[^\s<>"]+/gi,xr=/[.,!?;:'"]+$/;function st(e){try{const n=new URL(e);return n.protocol==="http:"||n.protocol==="https:"?e:null}catch{return null}}function vr(e){let n=e;for(;;){const t=n;if(n=n.replace(xr,""),n.endsWith(")")&&(n.match(/\(/g)||[]).length<(n.match(/\)/g)||[]).length&&(n=n.slice(0,-1)),n===t)return n}}function kr(e){const n=[];if(!e)return n;const t=a=>{if(!a)return;const s=n[n.length-1];(s==null?void 0:s.type)==="text"?s.text+=a:n.push({type:"text",text:a})};let r=0,o;for(sn.lastIndex=0;(o=sn.exec(e))!==null;)if(t(e.slice(r,o.index)),o[1]){const a=st(o[2]);a?n.push({type:a.includes("/products/")?"product":"link",href:a,label:o[1]}):t(o[0]),r=o.index+o[0].length}else{const a=vr(o[0]),s=st(a);s?n.push({type:"link",href:s,label:a}):t(a),r=o.index+a.length,sn.lastIndex=r}return t(e.slice(r)),n}const ln=new Map,yr=8e3;function wr(e,n){var t,r;if(!ln.has(e)){const o=new AbortController,a=setTimeout(()=>o.abort(),yr),s=((r=(t=window.Shopify)==null?void 0:t.currency)==null?void 0:r.active)||"PHP";ln.set(e,fetch(Gt(n),{credentials:"same-origin",headers:{Accept:"application/json"},signal:o.signal}).then(d=>d.ok?d.json():null).then(d=>Kt(d,e,s)).catch(()=>null).finally(()=>clearTimeout(a)))}return ln.get(e)}function lt(e){const n=(e==null?void 0:e.url)||null,[t,r]=k({url:null,preview:null,loading:!1});return K(()=>{if(!n){r({url:null,preview:null,loading:!1});return}let o=!0;return r({url:n,preview:null,loading:!0}),wr(n,e.handle).then(a=>{o&&r({url:n,preview:a,loading:!1})}),()=>{o=!1}},[n]),t.url===n?t:{url:n,preview:null,loading:!!n}}function Nr(e){return e?new Date(e).toLocaleTimeString("en-PH",{hour:"2-digit",minute:"2-digit"}):""}function Sr(e){if(!e)return null;const n=[];let t=0;for(const r of kr(e))r.type==="text"?Pr(r.text,t++,n):n.push(i("a",{href:r.href,target:"_blank",rel:"noopener noreferrer",style:{fontWeight:500,textDecoration:"underline",color:"inherit",wordBreak:"break-all"},children:r.label},t++));return{elements:n}}function Tr(e,n){const t=[],r=/\*\*([^*]+)\*\*/g;let o=0,a,s=0;for(;(a=r.exec(e))!==null;)a.index>o&&t.push(i("span",{children:e.slice(o,a.index)},`${n}-t${s++}`)),t.push(i("strong",{children:a[1]},`${n}-b${s++}`)),o=a.index+a[0].length;return o<e.length&&t.push(i("span",{children:e.slice(o)},`${n}-t${s++}`)),t}function Pr(e,n,t){if(!e)return;e.split(`
`).forEach((o,a)=>{a>0&&t.push(i("br",{},`${n}-br-${a}`));const s=o.match(/^\s*[-*+]\s+(.*)$/),d=s?s[1]:o;s&&t.push(i("span",{className:"li-bullet",children:"• "},`${n}-${a}-li`)),d&&t.push(...Tr(d,`${n}-${a}`))})}function cn({preview:e}){const n=Yt(e.price,e.currency);return i("a",{className:"product-card",href:e.url,target:"_blank",rel:"noopener noreferrer",children:[e.image?i("img",{className:"product-card-img",src:e.image,alt:"",loading:"lazy"}):i("div",{className:"product-card-img-placeholder",children:"💊"}),i("div",{className:"product-card-info",children:[i("div",{className:"product-card-name",children:e.title}),n&&i("div",{className:"product-card-price",children:n})]}),i("span",{className:"product-card-arrow",children:"→"})]})}const dn="Mediko Support";function He(e){return e==="agent"||e==="assistant"}function $r({content:e}){const n=nn(e,location.host),{preview:t}=lt(n);return t?i("div",{className:"product-cards",children:i(cn,{preview:t})}):null}function Cr({role:e,content:n,ts:t,showLabel:r,preview:o,hidePreview:a}){if(!n)return null;const s=Sr(n);if(!s)return null;const{elements:d}=s,u=He(e);return i("div",{className:`msg-row ${u?"assistant":"user"}`,children:[u&&r&&i("div",{className:"bot-label",children:dn}),i("div",{className:"bubble",children:d}),u&&o&&i("div",{className:"product-cards",children:i(cn,{preview:o})}),!u&&!a&&i($r,{content:n}),i("div",{className:"msg-time",children:Nr(t)})]})}function ct({label:e=dn}){return i("div",{className:"typing-row",children:[i("div",{className:"typing-bubble",children:[i("span",{className:"dot"}),i("span",{className:"dot"}),i("span",{className:"dot"})]}),i("span",{className:"typing-label",children:[e," is typing..."]})]})}const Er=()=>i("svg",{viewBox:"0 0 24 24",children:i("path",{d:"M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z"})}),dt=()=>i("svg",{viewBox:"0 0 24 24",children:i("path",{d:"M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"})}),Or=()=>i("svg",{viewBox:"0 0 24 24",children:i("path",{d:"M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"})}),Rr=()=>i("svg",{viewBox:"0 0 24 24",children:i("path",{d:"M17.65 6.35A7.958 7.958 0 0012 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0112 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z"})});function Ar({onDismiss:e}){const[n,t]=k(!1);function r(){t(!0),setTimeout(e,320)}return K(()=>{const o=setTimeout(r,6e3);return()=>clearTimeout(o)},[]),i("div",{className:`tooltip-popup${n?" hide":""}`,onClick:r,children:"Kumusta po! Paano ko kayo matutulungan ngayon? 😊"})}function Ir(e,n){return n||e===!1?"Offline":e===!0?"Online":null}function zr(){try{const e=typeof window<"u"?window.MEDIKO_CUSTOMER:null;return!e||typeof e!="object"?{name:"",email:"",phone:""}:{name:String(e.name||""),email:String(e.email||""),phone:String(e.phone||"")}}catch{return{name:"",email:"",phone:""}}}function Mr({onStart:e,starting:n}){const[t,r]=k(zr),[o,a]=k({}),[s,d]=k(null);function u(h){return g=>{const l=g.target.value;r(f=>({...f,[h]:l})),o[h]&&a(f=>({...f,[h]:void 0}))}}async function c(h){if(h.preventDefault(),n)return;d(null);const g=jt(t);if(!g.ok){a(g.errors);return}a({});const l=await e(g.value);!(l!=null&&l.ok)&&(l!=null&&l.error)&&d(l.error)}return i("form",{className:"prechat",onSubmit:c,noValidate:!0,children:[i("p",{className:"prechat-intro",children:"Enter your details to start."}),i("label",{className:"prechat-field",children:[i("span",{className:"prechat-label",children:"Name *"}),i("input",{className:`prechat-input${o.name?" invalid":""}`,type:"text",autoComplete:"name",maxLength:100,value:t.name,onChange:u("name"),"aria-invalid":!!o.name}),o.name&&i("span",{className:"prechat-error",children:o.name})]}),i("label",{className:"prechat-field",children:[i("span",{className:"prechat-label",children:"Email *"}),i("input",{className:`prechat-input${o.email?" invalid":""}`,type:"email",autoComplete:"email",value:t.email,onChange:u("email"),"aria-invalid":!!o.email}),o.email&&i("span",{className:"prechat-error",children:o.email})]}),i("label",{className:"prechat-field",children:[i("span",{className:"prechat-label",children:"Mobile number *"}),i("input",{className:`prechat-input${o.phone?" invalid":""}`,type:"tel",autoComplete:"tel",inputMode:"tel",placeholder:"09XXXXXXXXX",value:t.phone,onChange:u("phone"),"aria-invalid":!!o.phone}),o.phone&&i("span",{className:"prechat-error",children:o.phone})]}),s&&i("div",{className:"prechat-form-error",role:"alert",children:["⚠️ ",s]}),i("button",{className:"prechat-cta",type:"submit",disabled:n,children:n?"Starting…":"Start chat"}),i("p",{className:"prechat-privacy",children:"We only use your details to reply to your message."})]})}const ut=120;function Lr(){const[e,n]=k(!1),[t,r]=k(""),[o,a]=k(0),[s,d]=k(!1),[u,c]=k(!1),[h,g]=k("chat"),l=L(!1),f=L(null),y=L(null),w=L(0),{messages:T,isTyping:$,agentTyping:v,needsPrechat:N,ready:I,online:H,schedule:P,error:z,sessionId:M,autoOpen:q,starting:C,serverDown:D,startChat:pe,sendMessage:ee,notifyTyping:De,resetSession:ie,trackOrder:Ue}=sr();K(()=>{const m=setTimeout(()=>d(!0),2500);return()=>clearTimeout(m)},[]),K(()=>{q&&n(!0)},[q]),K(()=>{var m;if((m=f.current)==null||m.scrollIntoView({behavior:"smooth"}),I&&!e&&T.length>w.current){const A=T.slice(w.current).filter(F=>He(F.role)).length;A&&a(F=>F+A)}w.current=T.length},[T,$,v]),K(()=>{e&&(a(0),d(!1),setTimeout(()=>{var m;return(m=y.current)==null?void 0:m.focus()},200))},[e]);const fe=!!M&&!$&&!D,[ne,ye]=k(()=>new Set),se=nn(t,location.host),le=se&&!ne.has(se.url)?se:null,{preview:ce,loading:te}=lt(le);function we(){const m=t.trim();if(!m||!fe)return;const A=nn(m,location.host);r(""),ee(m,{hidePreview:!!A&&ne.has(A.url)})}function Ne(m){m.key==="Enter"&&!m.shiftKey&&(m.preventDefault(),we())}function un(m){r(m.target.value),m.target.value.trim()&&De()}St(()=>{const m=y.current;if(!m)return;m.style.height="auto";const A=m.offsetHeight-m.clientHeight,F=m.scrollHeight+A;m.style.height=Math.min(F,ut)+"px",m.style.overflowY=F>ut?"auto":"hidden"},[t,e,N,I]);const Se=Ir(H,D);K(()=>{!l.current&&H!==null&&c(H===!1)},[H]);const he=lr(P);return i(V,{children:[s&&!e&&i(Ar,{onDismiss:()=>d(!1)}),e&&i("div",{className:"chat-window",role:"dialog","aria-label":"Mediko Chat",children:[i("div",{className:"chat-header",children:[i("div",{className:"header-text",children:[i("div",{className:"header-name",children:dn}),Se&&i("div",{className:`header-status ${H&&!D?"online":"offline"}`,children:[i("span",{className:"status-dot","aria-hidden":"true"}),Se,he.length>0&&i("button",{className:"hours-btn",type:"button",onClick:()=>{l.current=!0,c(m=>!m)},"aria-expanded":u,"aria-label":"Office hours",title:"Office hours",children:"🕗"})]})]}),i("div",{className:"header-btns",children:[M&&i("button",{className:"icon-btn",onClick:ie,title:"New chat","aria-label":"New chat",children:i(Rr,{})}),i("button",{className:"icon-btn",onClick:()=>n(!1),title:"Close","aria-label":"Close",children:i(dt,{})})]})]}),u&&he.length>0&&i("div",{className:"hours-panel",children:he.map(m=>i("div",{className:"hours-row",children:[i("span",{children:m.days}),i("span",{children:m.hours})]},m.days))}),D&&i("div",{className:"offline-banner",role:"status",children:"No connection. Retrying…"}),I&&h==="chat"&&i("div",{className:"track-entry",children:i("button",{type:"button",className:"track-entry-btn",onClick:()=>g("track"),children:"📦 Track my order"})}),h==="track"?i(br,{trackOrder:Ue,onBack:()=>g("chat"),onChat:m=>{r(A=>A.trim()?A:`Order ${m}: `),g("chat"),setTimeout(()=>{var A;return(A=y.current)==null?void 0:A.focus()},50)}}):I?N?i("div",{className:"messages prechat-wrap",children:[z&&i("div",{className:"prechat-form-error",role:"alert",children:["⚠️ ",z]}),i(Mr,{onStart:pe,starting:C})]}):i(V,{children:[i("div",{className:"messages",children:[T.map((m,A)=>{var F;return i(Cr,{role:m.role,content:m.content,ts:m.ts,preview:m.preview,hidePreview:m.hidePreview,showLabel:He(m.role)&&(A===0||!He((F=T[A-1])==null?void 0:F.role))},m.id)}),$&&i(ct,{}),v&&i(ct,{}),z&&!D&&i("div",{className:"msg-row assistant",children:i("div",{className:"bubble",style:{background:"#fff0f0",borderColor:"#fecaca",color:"#991b1b"},children:["⚠️ ",z]})}),i("div",{ref:f})]}),le&&(te||ce)&&i("div",{className:"draft-preview",children:[ce?i(cn,{preview:ce}):i("div",{className:"draft-preview-loading",children:"Loading preview…"}),i("button",{className:"draft-preview-remove",type:"button","aria-label":"Remove preview",onClick:()=>ye(m=>new Set(m).add(le.url)),children:"×"})]}),i("div",{className:"input-area",children:[i("textarea",{ref:y,className:"msg-input",value:t,onChange:un,onKeyDown:Ne,placeholder:D?"Offline":"I-type ang inyong mensahe...",rows:1,disabled:!fe,"aria-label":"Message input"}),i("button",{className:"send-btn",onClick:we,disabled:!t.trim()||!fe,"aria-label":"Send",children:i(Or,{})})]})]}):i("div",{className:"messages","aria-busy":"true","aria-label":"Loading",children:[i("div",{className:"skeleton-row left",children:i("div",{className:"skeleton-bubble w70"})}),i("div",{className:"skeleton-row right",children:i("div",{className:"skeleton-bubble w50"})}),i("div",{className:"skeleton-row left",children:i("div",{className:"skeleton-bubble w60"})})]})]}),i("div",{className:"fab-wrap",children:[i("button",{className:`fab${e?" open":""}`,onClick:()=>n(m=>!m),"aria-label":e?"Close chat":"Open chat",children:[!e&&i("div",{className:"fab-pulse"}),e?i(dt,{}):i(Er,{})]}),!e&&o>0&&i("div",{className:"fab-badge",children:o>9?"9+":o})]})]})}const Hr=`/* ═══════════════════════════════════════════════════════
   Mediko Chat Widget — Senior-Friendly Redesign
   Primary: #187adc  Secondary: #ffb73a  Font: Poppins
   ═══════════════════════════════════════════════════════ */

:host {
  --mdk-primary:      #187adc;
  --mdk-primary-dk:   #115fa8;
  --mdk-primary-lt:   #e8f3fd;
  --mdk-secondary:    #ffb73a;
  --mdk-secondary-dk: #e09a1a;
  --mdk-secondary-lt: #fff8e8;
  --mdk-bg:           #ffffff;
  --mdk-surface:      #f7faff;
  --mdk-border:       #d0e4f7;
  --mdk-text:         #1a2e4a;
  --mdk-muted:        #6b85a3;
  --mdk-user-bg:      #187adc;
  --mdk-user-text:    #ffffff;
  --mdk-bot-bg:       #f0f7ff;
  --mdk-bot-text:     #1a2e4a;
  --mdk-radius:       16px;
  --mdk-shadow:       0 6px 24px rgba(0,0,0,.10);
  --mdk-shadow-fab:   0 3px 10px rgba(0,0,0,.16);
  font-family: 'Poppins', -apple-system, sans-serif;
}

*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

/* Force Poppins on every element — Shadow DOM doesn't inherit from :host automatically */
* { font-family: 'Poppins', -apple-system, sans-serif; }

/* ══ Tooltip popup ════════════════════════════════════ */

.tooltip-popup {
  position: fixed;
  bottom: 96px;
  right: 24px;
  background: var(--mdk-bg);
  color: var(--mdk-text);
  font-family: 'Poppins', sans-serif;
  font-size: 14px;
  font-weight: 500;
  padding: 12px 16px;
  border-radius: 12px 12px 4px 12px;
  border: 1px solid var(--mdk-border);
  box-shadow: var(--mdk-shadow);
  white-space: nowrap;
  pointer-events: none;
  animation: tooltipIn .3s ease both;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 2147483645;
}
.tooltip-popup::after {
  content: '';
  position: absolute;
  bottom: -7px;
  right: 20px;
  border: 7px solid transparent;
  border-top-color: var(--mdk-bg);
  border-bottom: none;
}
.tooltip-popup.hide {
  animation: tooltipOut .3s ease forwards;
}
@keyframes tooltipIn {
  from { opacity: 0; transform: translateY(10px) scale(.9); }
  to   { opacity: 1; transform: translateY(0)    scale(1);  }
}
@keyframes tooltipOut {
  to { opacity: 0; transform: translateY(6px) scale(.95); }
}

/* ══ FAB ═══════════════════════════════════════════════ */

.fab-wrap {
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 2147483646;
  pointer-events: auto;
}
.fab {
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--mdk-secondary);
  border: none;
  cursor: pointer;
  box-shadow: var(--mdk-shadow-fab);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform .2s ease, box-shadow .2s ease;
  position: relative;
  outline: none;
}
.fab:hover  { transform: scale(1.05); box-shadow: 0 5px 16px rgba(0,0,0,.2); }
.fab:active { transform: scale(.97); }
.fab svg    { width: 28px; height: 28px; fill: #1a2e4a; transition: transform .3s; }
.fab.open svg { transform: rotate(90deg); }

/* Pulse ring — subtle */
.fab-pulse {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: rgba(255,183,58,.25);
  animation: pulse 3s ease-out infinite;
}
@keyframes pulse {
  0%   { transform: scale(1);   opacity: .4; }
  100% { transform: scale(1.3); opacity: 0;  }
}

.fab-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: var(--mdk-secondary);
  color: #1a2e4a;
  font-family: 'Poppins', sans-serif;
  font-size: 11px;
  font-weight: 700;
  border-radius: 12px;
  min-width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 5px;
  border: 2px solid #fff;
  animation: badgePop .3s cubic-bezier(.34,1.56,.64,1);
}
@keyframes badgePop {
  from { transform: scale(0); }
  to   { transform: scale(1); }
}

/* ══ Chat window ════════════════════════════════════════ */

.chat-window {
  position: fixed;
  bottom: 102px;
  right: 24px;
  width: 390px;
  max-width: calc(100vw - 32px);
  height: 580px;
  max-height: calc(100vh - 120px);
  background: var(--mdk-bg);
  border-radius: var(--mdk-radius);
  box-shadow: var(--mdk-shadow);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 2147483645;
  transform-origin: bottom right;
  pointer-events: auto;
  border: 1.5px solid var(--mdk-border);
  animation: windowIn .3s cubic-bezier(.34,1.56,.64,1);
}
@keyframes windowIn {
  from { transform: scale(.88) translateY(12px); opacity: 0; }
  to   { transform: scale(1)   translateY(0);    opacity: 1; }
}

/* ══ Header ══════════════════════════════════════════════ */

.chat-header {
  background: var(--mdk-primary);
  padding: 14px 16px;
  display: flex;
  align-items: center;
  gap: 13px;
  flex-shrink: 0;
}
.header-text    { flex: 1; }
.header-name    { color: #fff; font-weight: 600; font-size: 15px; line-height: 1.2; }
.header-status  {
  color: rgba(255,255,255,.88);
  font-size: 12px;
  line-height: 1.35;
  margin-top: 3px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: #b9c7d6;
}
.header-status.online .status-dot { background: #4ade80; box-shadow: 0 0 0 2px rgba(74,222,128,.3); }
.header-status.offline .status-dot { background: var(--mdk-secondary); }
.header-btns    { display: flex; gap: 6px; }
.icon-btn {
  background: rgba(255,255,255,.18);
  border: 1.5px solid rgba(255,255,255,.25);
  border-radius: 10px;
  width: 34px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: background .15s;
}
.icon-btn:hover { background: rgba(255,255,255,.3); }
.icon-btn:disabled { opacity: .5; cursor: default; }
.icon-btn svg   { width: 16px; height: 16px; fill: #fff; }

/* ══ Messages ════════════════════════════════════════════ */

.messages {
  flex: 1;
  overflow-y: auto;
  padding: 18px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  scroll-behavior: smooth;
  background:
    radial-gradient(ellipse at 0% 0%, rgba(24,122,220,.04) 0%, transparent 60%),
    radial-gradient(ellipse at 100% 100%, rgba(255,183,58,.05) 0%, transparent 60%),
    #fff;
}
.messages::-webkit-scrollbar { width: 4px; }
.messages::-webkit-scrollbar-thumb { background: var(--mdk-border); border-radius: 2px; }

/* Message row */
.msg-row { display: flex; flex-direction: column; }
.msg-row.user      { align-items: flex-end; }
.msg-row.assistant { align-items: flex-start; }

/* Bot label */
.bot-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--mdk-primary);
  margin-bottom: 4px;
  padding-left: 2px;
  letter-spacing: .3px;
  text-transform: uppercase;
}

/* Bubble */
.bubble {
  max-width: 84%;
  padding: 12px 16px;
  font-size: 15px;
  line-height: 1.6;
  word-break: break-word;
  white-space: pre-wrap;
  position: relative;
}
.msg-row.user .bubble {
  background: var(--mdk-primary);
  color: #fff;
  border-radius: 16px 16px 4px 16px;
  box-shadow: none;
}
.msg-row.assistant .bubble {
  background: var(--mdk-bot-bg);
  color: var(--mdk-bot-text);
  border-radius: 18px 18px 18px 4px;
  border: 1.5px solid var(--mdk-border);
}

/* Links inside bubbles */
.msg-row.assistant .bubble a {
  color: var(--mdk-primary);
  font-weight: 600;
  text-decoration: underline;
  text-decoration-color: rgba(24,122,220,.4);
  text-underline-offset: 2px;
  transition: text-decoration-color .15s;
}
.msg-row.assistant .bubble a:hover { text-decoration-color: var(--mdk-primary); }
.msg-row.user .bubble a { color: rgba(255,255,255,.9); text-decoration: underline; }

.msg-time {
  font-size: 11px;
  color: var(--mdk-muted);
  margin-top: 4px;
  padding: 0 4px;
}

.li-bullet { color: var(--mdk-primary); font-weight: 700; }

/* Message entry animation */
.msg-row {
  animation: msgIn .25s cubic-bezier(.34,1.2,.64,1) both;
}
@keyframes msgIn {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ══ Typing indicator ════════════════════════════════════ */

.typing-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  animation: msgIn .25s ease both;
}
.typing-bubble {
  background: var(--mdk-bot-bg);
  border: 1.5px solid var(--mdk-border);
  border-radius: 18px 18px 18px 4px;
  padding: 14px 18px;
  display: flex;
  gap: 6px;
  align-items: center;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--mdk-primary);
  animation: typingBounce 1.1s ease-in-out infinite;
  opacity: .7;
}
.dot:nth-child(2) { animation-delay: .18s; }
.dot:nth-child(3) { animation-delay: .36s; }
@keyframes typingBounce {
  0%,80%,100% { transform: translateY(0);    opacity: .5; }
  40%          { transform: translateY(-7px); opacity: 1;  }
}

/* ══ Pre-chat form ═══════════════════════════════════════ */

.prechat-wrap { justify-content: flex-start; }
.prechat {
  display: flex;
  flex-direction: column;
  gap: 12px;
  color: var(--mdk-text);
}
.prechat-intro {
  font-size: 15px;
  line-height: 1.5;
  font-weight: 500;
}
.prechat-field { display: flex; flex-direction: column; gap: 5px; }
.prechat-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--mdk-text);
}
.prechat-input {
  border: 1.5px solid var(--mdk-border);
  border-radius: 10px;
  padding: 11px 13px;
  font-size: 15px;
  font-family: 'Poppins', sans-serif;
  color: var(--mdk-text);
  background: #fff;
  outline: none;
  transition: border-color .2s, box-shadow .2s;
}
.prechat-input:focus {
  border-color: var(--mdk-primary);
  box-shadow: 0 0 0 3px rgba(24,122,220,.12);
}
.prechat-input::placeholder { color: var(--mdk-muted); }
.prechat-input.invalid { border-color: #dc2626; }
.prechat-input.invalid:focus { box-shadow: 0 0 0 3px rgba(220,38,38,.12); }
.prechat-error { font-size: 12px; color: #b91c1c; line-height: 1.4; }
.prechat-form-error {
  background: #fff0f0;
  border: 1.5px solid #fecaca;
  color: #991b1b;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.45;
}
.prechat-cta {
  background: var(--mdk-secondary);
  color: var(--mdk-text);
  font-family: 'Poppins', sans-serif;
  font-weight: 600;
  font-size: 15px;
  border: none;
  border-radius: 10px;
  padding: 12px;
  cursor: pointer;
  margin-top: 4px;
  transition: background .15s, transform .15s;
}
.prechat-cta:hover:not(:disabled)  { background: var(--mdk-secondary-dk); }
.prechat-cta:active:not(:disabled) { transform: scale(.98); }
.prechat-cta:disabled { opacity: .6; cursor: default; }
.prechat-privacy {
  font-size: 12px;
  line-height: 1.5;
  color: var(--mdk-muted);
}

/* ══ Input area ═══════════════════════════════════════════ */

.input-area {
  padding: 14px 16px;
  border-top: 1.5px solid var(--mdk-border);
  display: flex;
  gap: 10px;
  align-items: flex-end;
  background: var(--mdk-surface);
  flex-shrink: 0;
}
.msg-input {
  flex: 1;
  border: 1.5px solid var(--mdk-border);
  border-radius: 16px;
  padding: 12px 16px;
  font-size: 15px;
  font-family: 'Poppins', sans-serif;
  color: var(--mdk-text);
  resize: none;
  outline: none;
  min-height: 48px;          /* 21px line + 24px padding + 3px border (border-box) */
  max-height: 120px;
  overflow-y: hidden;        /* ChatWidget turns scrolling on only past max-height */
  background: #fff;
  line-height: 1.4;
  transition: border-color .2s, box-shadow .2s;
}
.msg-input:focus {
  border-color: var(--mdk-primary);
  box-shadow: 0 0 0 3px rgba(24,122,220,.12);
}
.msg-input::placeholder { color: var(--mdk-muted); }

.send-btn {
  width: 46px;
  height: 46px;
  border-radius: 50%;
  background: linear-gradient(135deg, #187adc, #1563b8);
  border: none;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: transform .2s cubic-bezier(.34,1.56,.64,1), box-shadow .2s, opacity .2s;
  box-shadow: 0 4px 14px rgba(24,122,220,.35);
}
.send-btn:hover:not(:disabled) {
  transform: scale(1.1);
  box-shadow: 0 6px 18px rgba(24,122,220,.45);
}
.send-btn:active:not(:disabled) { transform: scale(.95); }
.send-btn:disabled { opacity: .4; cursor: default; box-shadow: none; }
.send-btn svg { width: 20px; height: 20px; fill: #fff; transform: translateX(1px); }

/* ══ Footer ═══════════════════════════════════════════════ */


/* ══ Scrollbar ════════════════════════════════════════════ */

::-webkit-scrollbar { width: 4px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--mdk-border); border-radius: 2px; }

/* ══ Mobile responsive ════════════════════════════════════ */

@media (max-width: 480px) {
  .chat-window {
    width: 100vw;
    height: 100dvh;
    max-width: 100vw;
    max-height: 100dvh;
    bottom: 0;
    right: 0;
    border-radius: 0;
    border: none;
  }

  .fab-wrap {
    bottom: 16px;
    right: 16px;
  }
  /* On fullscreen mobile the FAB would overlap the input/footer.
     Hide it while the chat is open — the header ✕ button closes it. */
  .fab.open { display: none; }

  .tooltip-popup {
    right: 16px;
    bottom: 94px;
    font-size: 13px;
    max-width: calc(100vw - 32px);
    white-space: normal;
  }

  .bubble {
    max-width: 92%;
    font-size: 16px;
  }

  .msg-input,
  .prechat-input {
    font-size: 16px; /* prevents iOS auto-zoom on focus */
  }

  .header-name { font-size: 15px; }
}

/* ── Product cards ════════════════════════════════════════ */

.product-card {
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--mdk-primary-lt);
  border: 1.5px solid var(--mdk-border);
  border-radius: 12px;
  padding: 10px 13px;
  max-width: 88%;
  text-decoration: none;
  margin-top: 4px;
  transition: all .18s;
  pointer-events: auto;
}
.product-card:hover {
  background: #d0e8f8;
  border-color: var(--mdk-primary);
  transform: translateY(-1px);
  box-shadow: 0 3px 10px rgba(24,122,220,.15);
}
.product-card-body { flex: 1; min-width: 0; }
.product-card-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--mdk-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.product-card-price {
  font-size: 11px;
  color: var(--mdk-muted);
  margin-top: 2px;
  font-weight: 500;
}

/* ── Product links ──────────────────────────────────────── */
.msg-row.assistant .bubble a.product-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--mdk-primary-lt);
  color: var(--mdk-primary);
  font-weight: 600;
  padding: 3px 10px 3px 8px;
  border-radius: 8px;
  text-decoration: none;
  font-size: 13px;
  border: 1px solid var(--mdk-border);
  margin: 2px 0;
  transition: all .15s;
}
.msg-row.assistant .bubble a.product-link::before { content: '🛒'; font-size: 12px; }
.msg-row.assistant .bubble a.product-link:hover {
  background: var(--mdk-primary);
  color: #fff;
  border-color: var(--mdk-primary);
}

/* ── Typing label ───────────────────────────────────────── */
.typing-label { font-size: 11px; color: var(--mdk-muted); margin-left: 6px; font-style: italic; }

/* Agent typing label */
.typing-label {
  font-size: 12px;
  color: var(--mdk-amber);
  font-weight: 500;
  margin-left: 4px;
}

/* ══ Typing label ═════════════════════════════════════════ */
.typing-label {
  font-size: 11px;
  color: var(--mdk-muted);
  align-self: center;
  font-style: italic;
}

/* ══ Product cards ════════════════════════════════════════ */
.product-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.product-card {
  background: #fff;
  border: 1.5px solid var(--mdk-border);
  border-radius: 14px;
  padding: 10px 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  transition: box-shadow .2s, transform .15s;
}
.product-card:hover {
  box-shadow: 0 4px 14px rgba(24,122,220,.15);
  transform: translateY(-1px);
}
.product-card-img {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  object-fit: cover;
  background: var(--mdk-primary-lt);
  flex-shrink: 0;
}
.product-card-img-placeholder {
  width: 48px;
  height: 48px;
  border-radius: 8px;
  background: var(--mdk-primary-lt);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}
.product-card-info { flex: 1; min-width: 0; }
.product-card-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--mdk-text);
  line-height: 1.3;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.product-card-price {
  font-size: 13px;
  color: var(--mdk-primary);
  font-weight: 700;
  margin-top: 3px;
}
.product-card-arrow {
  font-size: 14px;
  color: var(--mdk-muted);
  flex-shrink: 0;
}

/* ══ Product cards ════════════════════════════════════════ */

.product-card {
  display: flex;
  align-items: center;
  gap: 12px;
  background: var(--mdk-bg);
  border: 1.5px solid var(--mdk-border);
  border-radius: 14px;
  padding: 10px 12px;
  text-decoration: none;
  color: var(--mdk-text);
  margin: 4px 0;
  transition: box-shadow .2s, transform .2s;
  max-width: 260px;
}
.product-card:hover {
  box-shadow: 0 4px 16px rgba(24,122,220,.15);
  transform: translateY(-1px);
}
.product-card-img {
  width: 56px;
  height: 56px;
  border-radius: 8px;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--mdk-surface);
}
.product-card-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.product-card-title { font-size: 13px; font-weight: 600; color: var(--mdk-text); line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.product-card-price { font-size: 14px; font-weight: 700; color: var(--mdk-primary); }
.product-card-cta   { font-size: 11px; color: var(--mdk-primary); font-weight: 500; }

/* ══ Typing label ═════════════════════════════════════════ */

.typing-label {
  font-size: 11px;
  color: var(--mdk-muted);
  align-self: center;
  margin-left: 4px;
}

/* ── Typing label ─────────────────────────────────────── */
.typing-label {
  font-size: 11px;
  color: var(--mdk-amber, #d97706);
  font-weight: 500;
  margin-left: 6px;
}

/* ── Product cards ────────────────────────────────────── */
.product-cards {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.product-card {
  background: #fff;
  border: 1.5px solid var(--mdk-border);
  border-radius: 14px;
  padding: 11px 13px;
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  transition: box-shadow .2s, transform .15s;
  text-decoration: none;
  color: inherit;
}
.product-card:hover {
  box-shadow: 0 4px 16px rgba(24,122,220,.15);
  transform: translateY(-1px);
}
.product-img {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  object-fit: cover;
  background: var(--mdk-surface);
  flex-shrink: 0;
}
.product-img-placeholder {
  width: 52px;
  height: 52px;
  border-radius: 10px;
  background: var(--mdk-primary-lt);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 22px;
  flex-shrink: 0;
}
.product-info { flex: 1; min-width: 0; }
.product-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--mdk-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-bottom: 3px;
}
.product-price {
  font-size: 13px;
  font-weight: 700;
  color: var(--mdk-primary);
}
.product-view {
  font-size: 11px;
  font-weight: 600;
  color: var(--mdk-primary);
  background: var(--mdk-primary-lt);
  border-radius: 8px;
  padding: 4px 10px;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ── Server unreachable ─────────────────────────────────── */
.offline-banner {
  background: var(--mdk-secondary-lt);
  border-bottom: 1px solid var(--mdk-secondary);
  color: var(--mdk-text);
  font-size: 12.5px;
  line-height: 1.45;
  padding: 8px 14px;
}

/* ── Loading skeleton ───────────────────────────────────── */
.skeleton-row { display: flex; margin: 6px 0; }
.skeleton-row.left  { justify-content: flex-start; }
.skeleton-row.right { justify-content: flex-end; }
.skeleton-bubble {
  height: 38px;
  border-radius: 14px;
  background: linear-gradient(90deg, var(--mdk-bot-bg) 25%, var(--mdk-border) 50%, var(--mdk-bot-bg) 75%);
  background-size: 200% 100%;
  animation: skeletonShimmer 1.2s ease-in-out infinite;
}
.skeleton-bubble.w50 { width: 50%; }
.skeleton-bubble.w60 { width: 60%; }
.skeleton-bubble.w70 { width: 70%; }
@keyframes skeletonShimmer { from { background-position: 200% 0; } to { background-position: -200% 0; } }
@media (prefers-reduced-motion: reduce) { .skeleton-bubble { animation: none; } }

/* ── Link preview above the input (WhatsApp-style) ──────── */
.draft-preview {
  position: relative;
  padding: 8px 12px 0;
  background: var(--mdk-bg);
  border-top: 1px solid var(--mdk-border);
}
.draft-preview .product-card { margin: 0; padding-right: 34px; }
.draft-preview-loading { font-size: 12.5px; color: var(--mdk-muted); padding: 6px 2px; }
.draft-preview-remove {
  position: absolute;
  top: 12px;
  right: 18px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  border: 1px solid var(--mdk-border);
  background: #fff;
  color: var(--mdk-text);
  font-size: 15px;
  line-height: 20px;
  cursor: pointer;
}
.draft-preview-remove:hover { background: var(--mdk-surface); }

/* ── Office hours (🕗 in the header) ───────────────────── */
.hours-btn {
  background: rgba(255,255,255,.18);
  border: none;
  border-radius: 10px;
  padding: 1px 6px;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.hours-btn:hover, .hours-btn[aria-expanded="true"] { background: rgba(255,255,255,.32); }
.hours-panel {
  background: var(--mdk-surface);
  border-bottom: 1px solid var(--mdk-border);
  padding: 8px 14px;
  font-size: 12.5px;
  color: var(--mdk-text);
}
.hours-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
.hours-row span:first-child { font-weight: 600; }

/* ── Track my order ─────────────────────────────────────── */
.track-entry { padding: 6px 14px; border-bottom: 1px solid var(--mdk-border); background: var(--mdk-bg); }
.track-entry-btn {
  background: var(--mdk-primary-lt);
  color: var(--mdk-primary-dk);
  border: 1px solid var(--mdk-border);
  border-radius: 999px;
  padding: 4px 12px;
  font: 600 12.5px 'Poppins', sans-serif;
  cursor: pointer;
}
.track-entry-btn:hover { background: var(--mdk-surface); }
.track-wrap { display: flex; flex-direction: column; gap: 10px; }
.track-head { display: flex; align-items: center; gap: 10px; }
.track-back { background: none; border: none; color: var(--mdk-primary); font: 600 13px 'Poppins', sans-serif; cursor: pointer; padding: 0; }
.track-title { font-weight: 600; font-size: 14px; }
.track-result { display: flex; flex-direction: column; gap: 8px; background: #fff; border: 1px solid var(--mdk-border); border-radius: 12px; padding: 14px; }
.track-order { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.track-order-name { font-weight: 700; font-size: 15px; }
.track-state { font-size: 12px; font-weight: 600; border-radius: 999px; padding: 2px 10px; background: var(--mdk-primary-lt); color: var(--mdk-primary-dk); }
.track-state.shipped { background: var(--mdk-primary-lt); color: var(--mdk-primary-dk); }
.track-state.delivered { background: #dcfce7; color: #166534; }
.track-state.partially_shipped { background: var(--mdk-secondary-lt); color: #92400e; }
.track-state.cancelled { background: #fee2e2; color: #991b1b; }
.track-line { font-size: 13px; color: var(--mdk-text); }
.track-link { text-align: center; text-decoration: none; display: block; }
.track-secondary { background: none; border: 1px solid var(--mdk-border); border-radius: 10px; padding: 8px; font: 500 13px 'Poppins', sans-serif; color: var(--mdk-text); cursor: pointer; }
.track-secondary:hover { background: var(--mdk-surface); }

/* Track my order: list + form layout (form is outside .prechat, so it needs its own gaps) */
.track-form { display: flex; flex-direction: column; gap: 12px; }
.track-form .prechat-cta { width: 100%; }
.track-subtitle { font-size: 12.5px; font-weight: 600; color: var(--mdk-muted); text-transform: uppercase; letter-spacing: .04em; }
.track-list { display: flex; flex-direction: column; gap: 8px; }
.track-list .skeleton-bubble { width: 100%; height: 52px; }
.track-item {
  display: flex; align-items: center; justify-content: space-between; gap: 10px;
  width: 100%; text-align: left;
  background: #fff; border: 1px solid var(--mdk-border); border-radius: 12px;
  padding: 10px 12px; cursor: pointer; font-family: 'Poppins', sans-serif; color: var(--mdk-text);
}
.track-item:hover { background: var(--mdk-surface); border-color: var(--mdk-primary); }
.track-item-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.track-item-date { font-size: 12px; color: var(--mdk-muted); }
.track-item .track-state { flex: none; }
.track-wrap > .track-line { color: var(--mdk-muted); }
`;function pt(){if(document.getElementById("mediko-chat-root"))return;const e=document.createElement("div");e.id="mediko-chat-root",e.style.cssText=["all: initial","position: fixed","bottom: 0","right: 0","width: 0","height: 0","z-index: 2147483647","pointer-events: none"].join("; "),e.innerHTML=" ",document.body.appendChild(e);const n=e.attachShadow({mode:"open"}),t=document.createElement("link");t.rel="stylesheet",t.href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap",n.appendChild(t);const r=document.createElement("style");r.textContent=Hr,n.appendChild(r);const o=document.createElement("div");n.appendChild(o),Dt(o).render(i(Lr,{}))}document.readyState==="loading"?document.addEventListener("DOMContentLoaded",pt):pt()})();
