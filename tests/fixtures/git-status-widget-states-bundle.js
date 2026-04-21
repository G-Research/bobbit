"use strict";
(() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __decorateClass = (decorators, target, key, kind) => {
    var result = kind > 1 ? void 0 : kind ? __getOwnPropDesc(target, key) : target;
    for (var i6 = decorators.length - 1, decorator; i6 >= 0; i6--)
      if (decorator = decorators[i6])
        result = (kind ? decorator(target, key, result) : decorator(result)) || result;
    if (kind && result) __defProp(target, key, result);
    return result;
  };

  // node_modules/@lit/reactive-element/css-tag.js
  var t = globalThis;
  var e = t.ShadowRoot && (void 0 === t.ShadyCSS || t.ShadyCSS.nativeShadow) && "adoptedStyleSheets" in Document.prototype && "replace" in CSSStyleSheet.prototype;
  var s = /* @__PURE__ */ Symbol();
  var o = /* @__PURE__ */ new WeakMap();
  var n = class {
    constructor(t6, e8, o9) {
      if (this._$cssResult$ = true, o9 !== s) throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");
      this.cssText = t6, this.t = e8;
    }
    get styleSheet() {
      let t6 = this.o;
      const s5 = this.t;
      if (e && void 0 === t6) {
        const e8 = void 0 !== s5 && 1 === s5.length;
        e8 && (t6 = o.get(s5)), void 0 === t6 && ((this.o = t6 = new CSSStyleSheet()).replaceSync(this.cssText), e8 && o.set(s5, t6));
      }
      return t6;
    }
    toString() {
      return this.cssText;
    }
  };
  var r = (t6) => new n("string" == typeof t6 ? t6 : t6 + "", void 0, s);
  var S = (s5, o9) => {
    if (e) s5.adoptedStyleSheets = o9.map((t6) => t6 instanceof CSSStyleSheet ? t6 : t6.styleSheet);
    else for (const e8 of o9) {
      const o10 = document.createElement("style"), n7 = t.litNonce;
      void 0 !== n7 && o10.setAttribute("nonce", n7), o10.textContent = e8.cssText, s5.appendChild(o10);
    }
  };
  var c = e ? (t6) => t6 : (t6) => t6 instanceof CSSStyleSheet ? ((t7) => {
    let e8 = "";
    for (const s5 of t7.cssRules) e8 += s5.cssText;
    return r(e8);
  })(t6) : t6;

  // node_modules/@lit/reactive-element/reactive-element.js
  var { is: i2, defineProperty: e2, getOwnPropertyDescriptor: h, getOwnPropertyNames: r2, getOwnPropertySymbols: o2, getPrototypeOf: n2 } = Object;
  var a = globalThis;
  var c2 = a.trustedTypes;
  var l = c2 ? c2.emptyScript : "";
  var p = a.reactiveElementPolyfillSupport;
  var d = (t6, s5) => t6;
  var u = { toAttribute(t6, s5) {
    switch (s5) {
      case Boolean:
        t6 = t6 ? l : null;
        break;
      case Object:
      case Array:
        t6 = null == t6 ? t6 : JSON.stringify(t6);
    }
    return t6;
  }, fromAttribute(t6, s5) {
    let i6 = t6;
    switch (s5) {
      case Boolean:
        i6 = null !== t6;
        break;
      case Number:
        i6 = null === t6 ? null : Number(t6);
        break;
      case Object:
      case Array:
        try {
          i6 = JSON.parse(t6);
        } catch (t7) {
          i6 = null;
        }
    }
    return i6;
  } };
  var f = (t6, s5) => !i2(t6, s5);
  var b = { attribute: true, type: String, converter: u, reflect: false, useDefault: false, hasChanged: f };
  Symbol.metadata ??= /* @__PURE__ */ Symbol("metadata"), a.litPropertyMetadata ??= /* @__PURE__ */ new WeakMap();
  var y = class extends HTMLElement {
    static addInitializer(t6) {
      this._$Ei(), (this.l ??= []).push(t6);
    }
    static get observedAttributes() {
      return this.finalize(), this._$Eh && [...this._$Eh.keys()];
    }
    static createProperty(t6, s5 = b) {
      if (s5.state && (s5.attribute = false), this._$Ei(), this.prototype.hasOwnProperty(t6) && ((s5 = Object.create(s5)).wrapped = true), this.elementProperties.set(t6, s5), !s5.noAccessor) {
        const i6 = /* @__PURE__ */ Symbol(), h4 = this.getPropertyDescriptor(t6, i6, s5);
        void 0 !== h4 && e2(this.prototype, t6, h4);
      }
    }
    static getPropertyDescriptor(t6, s5, i6) {
      const { get: e8, set: r8 } = h(this.prototype, t6) ?? { get() {
        return this[s5];
      }, set(t7) {
        this[s5] = t7;
      } };
      return { get: e8, set(s6) {
        const h4 = e8?.call(this);
        r8?.call(this, s6), this.requestUpdate(t6, h4, i6);
      }, configurable: true, enumerable: true };
    }
    static getPropertyOptions(t6) {
      return this.elementProperties.get(t6) ?? b;
    }
    static _$Ei() {
      if (this.hasOwnProperty(d("elementProperties"))) return;
      const t6 = n2(this);
      t6.finalize(), void 0 !== t6.l && (this.l = [...t6.l]), this.elementProperties = new Map(t6.elementProperties);
    }
    static finalize() {
      if (this.hasOwnProperty(d("finalized"))) return;
      if (this.finalized = true, this._$Ei(), this.hasOwnProperty(d("properties"))) {
        const t7 = this.properties, s5 = [...r2(t7), ...o2(t7)];
        for (const i6 of s5) this.createProperty(i6, t7[i6]);
      }
      const t6 = this[Symbol.metadata];
      if (null !== t6) {
        const s5 = litPropertyMetadata.get(t6);
        if (void 0 !== s5) for (const [t7, i6] of s5) this.elementProperties.set(t7, i6);
      }
      this._$Eh = /* @__PURE__ */ new Map();
      for (const [t7, s5] of this.elementProperties) {
        const i6 = this._$Eu(t7, s5);
        void 0 !== i6 && this._$Eh.set(i6, t7);
      }
      this.elementStyles = this.finalizeStyles(this.styles);
    }
    static finalizeStyles(s5) {
      const i6 = [];
      if (Array.isArray(s5)) {
        const e8 = new Set(s5.flat(1 / 0).reverse());
        for (const s6 of e8) i6.unshift(c(s6));
      } else void 0 !== s5 && i6.push(c(s5));
      return i6;
    }
    static _$Eu(t6, s5) {
      const i6 = s5.attribute;
      return false === i6 ? void 0 : "string" == typeof i6 ? i6 : "string" == typeof t6 ? t6.toLowerCase() : void 0;
    }
    constructor() {
      super(), this._$Ep = void 0, this.isUpdatePending = false, this.hasUpdated = false, this._$Em = null, this._$Ev();
    }
    _$Ev() {
      this._$ES = new Promise((t6) => this.enableUpdating = t6), this._$AL = /* @__PURE__ */ new Map(), this._$E_(), this.requestUpdate(), this.constructor.l?.forEach((t6) => t6(this));
    }
    addController(t6) {
      (this._$EO ??= /* @__PURE__ */ new Set()).add(t6), void 0 !== this.renderRoot && this.isConnected && t6.hostConnected?.();
    }
    removeController(t6) {
      this._$EO?.delete(t6);
    }
    _$E_() {
      const t6 = /* @__PURE__ */ new Map(), s5 = this.constructor.elementProperties;
      for (const i6 of s5.keys()) this.hasOwnProperty(i6) && (t6.set(i6, this[i6]), delete this[i6]);
      t6.size > 0 && (this._$Ep = t6);
    }
    createRenderRoot() {
      const t6 = this.shadowRoot ?? this.attachShadow(this.constructor.shadowRootOptions);
      return S(t6, this.constructor.elementStyles), t6;
    }
    connectedCallback() {
      this.renderRoot ??= this.createRenderRoot(), this.enableUpdating(true), this._$EO?.forEach((t6) => t6.hostConnected?.());
    }
    enableUpdating(t6) {
    }
    disconnectedCallback() {
      this._$EO?.forEach((t6) => t6.hostDisconnected?.());
    }
    attributeChangedCallback(t6, s5, i6) {
      this._$AK(t6, i6);
    }
    _$ET(t6, s5) {
      const i6 = this.constructor.elementProperties.get(t6), e8 = this.constructor._$Eu(t6, i6);
      if (void 0 !== e8 && true === i6.reflect) {
        const h4 = (void 0 !== i6.converter?.toAttribute ? i6.converter : u).toAttribute(s5, i6.type);
        this._$Em = t6, null == h4 ? this.removeAttribute(e8) : this.setAttribute(e8, h4), this._$Em = null;
      }
    }
    _$AK(t6, s5) {
      const i6 = this.constructor, e8 = i6._$Eh.get(t6);
      if (void 0 !== e8 && this._$Em !== e8) {
        const t7 = i6.getPropertyOptions(e8), h4 = "function" == typeof t7.converter ? { fromAttribute: t7.converter } : void 0 !== t7.converter?.fromAttribute ? t7.converter : u;
        this._$Em = e8;
        const r8 = h4.fromAttribute(s5, t7.type);
        this[e8] = r8 ?? this._$Ej?.get(e8) ?? r8, this._$Em = null;
      }
    }
    requestUpdate(t6, s5, i6, e8 = false, h4) {
      if (void 0 !== t6) {
        const r8 = this.constructor;
        if (false === e8 && (h4 = this[t6]), i6 ??= r8.getPropertyOptions(t6), !((i6.hasChanged ?? f)(h4, s5) || i6.useDefault && i6.reflect && h4 === this._$Ej?.get(t6) && !this.hasAttribute(r8._$Eu(t6, i6)))) return;
        this.C(t6, s5, i6);
      }
      false === this.isUpdatePending && (this._$ES = this._$EP());
    }
    C(t6, s5, { useDefault: i6, reflect: e8, wrapped: h4 }, r8) {
      i6 && !(this._$Ej ??= /* @__PURE__ */ new Map()).has(t6) && (this._$Ej.set(t6, r8 ?? s5 ?? this[t6]), true !== h4 || void 0 !== r8) || (this._$AL.has(t6) || (this.hasUpdated || i6 || (s5 = void 0), this._$AL.set(t6, s5)), true === e8 && this._$Em !== t6 && (this._$Eq ??= /* @__PURE__ */ new Set()).add(t6));
    }
    async _$EP() {
      this.isUpdatePending = true;
      try {
        await this._$ES;
      } catch (t7) {
        Promise.reject(t7);
      }
      const t6 = this.scheduleUpdate();
      return null != t6 && await t6, !this.isUpdatePending;
    }
    scheduleUpdate() {
      return this.performUpdate();
    }
    performUpdate() {
      if (!this.isUpdatePending) return;
      if (!this.hasUpdated) {
        if (this.renderRoot ??= this.createRenderRoot(), this._$Ep) {
          for (const [t8, s6] of this._$Ep) this[t8] = s6;
          this._$Ep = void 0;
        }
        const t7 = this.constructor.elementProperties;
        if (t7.size > 0) for (const [s6, i6] of t7) {
          const { wrapped: t8 } = i6, e8 = this[s6];
          true !== t8 || this._$AL.has(s6) || void 0 === e8 || this.C(s6, void 0, i6, e8);
        }
      }
      let t6 = false;
      const s5 = this._$AL;
      try {
        t6 = this.shouldUpdate(s5), t6 ? (this.willUpdate(s5), this._$EO?.forEach((t7) => t7.hostUpdate?.()), this.update(s5)) : this._$EM();
      } catch (s6) {
        throw t6 = false, this._$EM(), s6;
      }
      t6 && this._$AE(s5);
    }
    willUpdate(t6) {
    }
    _$AE(t6) {
      this._$EO?.forEach((t7) => t7.hostUpdated?.()), this.hasUpdated || (this.hasUpdated = true, this.firstUpdated(t6)), this.updated(t6);
    }
    _$EM() {
      this._$AL = /* @__PURE__ */ new Map(), this.isUpdatePending = false;
    }
    get updateComplete() {
      return this.getUpdateComplete();
    }
    getUpdateComplete() {
      return this._$ES;
    }
    shouldUpdate(t6) {
      return true;
    }
    update(t6) {
      this._$Eq &&= this._$Eq.forEach((t7) => this._$ET(t7, this[t7])), this._$EM();
    }
    updated(t6) {
    }
    firstUpdated(t6) {
    }
  };
  y.elementStyles = [], y.shadowRootOptions = { mode: "open" }, y[d("elementProperties")] = /* @__PURE__ */ new Map(), y[d("finalized")] = /* @__PURE__ */ new Map(), p?.({ ReactiveElement: y }), (a.reactiveElementVersions ??= []).push("2.1.2");

  // node_modules/lit-html/lit-html.js
  var t2 = globalThis;
  var i3 = (t6) => t6;
  var s2 = t2.trustedTypes;
  var e3 = s2 ? s2.createPolicy("lit-html", { createHTML: (t6) => t6 }) : void 0;
  var h2 = "$lit$";
  var o3 = `lit$${Math.random().toFixed(9).slice(2)}$`;
  var n3 = "?" + o3;
  var r3 = `<${n3}>`;
  var l2 = document;
  var c3 = () => l2.createComment("");
  var a2 = (t6) => null === t6 || "object" != typeof t6 && "function" != typeof t6;
  var u2 = Array.isArray;
  var d2 = (t6) => u2(t6) || "function" == typeof t6?.[Symbol.iterator];
  var f2 = "[ 	\n\f\r]";
  var v = /<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g;
  var _ = /-->/g;
  var m = />/g;
  var p2 = RegExp(`>|${f2}(?:([^\\s"'>=/]+)(${f2}*=${f2}*(?:[^ 	
\f\r"'\`<>=]|("|')|))|$)`, "g");
  var g = /'/g;
  var $ = /"/g;
  var y2 = /^(?:script|style|textarea|title)$/i;
  var x = (t6) => (i6, ...s5) => ({ _$litType$: t6, strings: i6, values: s5 });
  var b2 = x(1);
  var w = x(2);
  var T = x(3);
  var E = /* @__PURE__ */ Symbol.for("lit-noChange");
  var A = /* @__PURE__ */ Symbol.for("lit-nothing");
  var C = /* @__PURE__ */ new WeakMap();
  var P = l2.createTreeWalker(l2, 129);
  function V(t6, i6) {
    if (!u2(t6) || !t6.hasOwnProperty("raw")) throw Error("invalid template strings array");
    return void 0 !== e3 ? e3.createHTML(i6) : i6;
  }
  var N = (t6, i6) => {
    const s5 = t6.length - 1, e8 = [];
    let n7, l3 = 2 === i6 ? "<svg>" : 3 === i6 ? "<math>" : "", c5 = v;
    for (let i7 = 0; i7 < s5; i7++) {
      const s6 = t6[i7];
      let a3, u3, d3 = -1, f4 = 0;
      for (; f4 < s6.length && (c5.lastIndex = f4, u3 = c5.exec(s6), null !== u3); ) f4 = c5.lastIndex, c5 === v ? "!--" === u3[1] ? c5 = _ : void 0 !== u3[1] ? c5 = m : void 0 !== u3[2] ? (y2.test(u3[2]) && (n7 = RegExp("</" + u3[2], "g")), c5 = p2) : void 0 !== u3[3] && (c5 = p2) : c5 === p2 ? ">" === u3[0] ? (c5 = n7 ?? v, d3 = -1) : void 0 === u3[1] ? d3 = -2 : (d3 = c5.lastIndex - u3[2].length, a3 = u3[1], c5 = void 0 === u3[3] ? p2 : '"' === u3[3] ? $ : g) : c5 === $ || c5 === g ? c5 = p2 : c5 === _ || c5 === m ? c5 = v : (c5 = p2, n7 = void 0);
      const x2 = c5 === p2 && t6[i7 + 1].startsWith("/>") ? " " : "";
      l3 += c5 === v ? s6 + r3 : d3 >= 0 ? (e8.push(a3), s6.slice(0, d3) + h2 + s6.slice(d3) + o3 + x2) : s6 + o3 + (-2 === d3 ? i7 : x2);
    }
    return [V(t6, l3 + (t6[s5] || "<?>") + (2 === i6 ? "</svg>" : 3 === i6 ? "</math>" : "")), e8];
  };
  var S2 = class _S {
    constructor({ strings: t6, _$litType$: i6 }, e8) {
      let r8;
      this.parts = [];
      let l3 = 0, a3 = 0;
      const u3 = t6.length - 1, d3 = this.parts, [f4, v2] = N(t6, i6);
      if (this.el = _S.createElement(f4, e8), P.currentNode = this.el.content, 2 === i6 || 3 === i6) {
        const t7 = this.el.content.firstChild;
        t7.replaceWith(...t7.childNodes);
      }
      for (; null !== (r8 = P.nextNode()) && d3.length < u3; ) {
        if (1 === r8.nodeType) {
          if (r8.hasAttributes()) for (const t7 of r8.getAttributeNames()) if (t7.endsWith(h2)) {
            const i7 = v2[a3++], s5 = r8.getAttribute(t7).split(o3), e9 = /([.?@])?(.*)/.exec(i7);
            d3.push({ type: 1, index: l3, name: e9[2], strings: s5, ctor: "." === e9[1] ? I : "?" === e9[1] ? L : "@" === e9[1] ? z : H }), r8.removeAttribute(t7);
          } else t7.startsWith(o3) && (d3.push({ type: 6, index: l3 }), r8.removeAttribute(t7));
          if (y2.test(r8.tagName)) {
            const t7 = r8.textContent.split(o3), i7 = t7.length - 1;
            if (i7 > 0) {
              r8.textContent = s2 ? s2.emptyScript : "";
              for (let s5 = 0; s5 < i7; s5++) r8.append(t7[s5], c3()), P.nextNode(), d3.push({ type: 2, index: ++l3 });
              r8.append(t7[i7], c3());
            }
          }
        } else if (8 === r8.nodeType) if (r8.data === n3) d3.push({ type: 2, index: l3 });
        else {
          let t7 = -1;
          for (; -1 !== (t7 = r8.data.indexOf(o3, t7 + 1)); ) d3.push({ type: 7, index: l3 }), t7 += o3.length - 1;
        }
        l3++;
      }
    }
    static createElement(t6, i6) {
      const s5 = l2.createElement("template");
      return s5.innerHTML = t6, s5;
    }
  };
  function M(t6, i6, s5 = t6, e8) {
    if (i6 === E) return i6;
    let h4 = void 0 !== e8 ? s5._$Co?.[e8] : s5._$Cl;
    const o9 = a2(i6) ? void 0 : i6._$litDirective$;
    return h4?.constructor !== o9 && (h4?._$AO?.(false), void 0 === o9 ? h4 = void 0 : (h4 = new o9(t6), h4._$AT(t6, s5, e8)), void 0 !== e8 ? (s5._$Co ??= [])[e8] = h4 : s5._$Cl = h4), void 0 !== h4 && (i6 = M(t6, h4._$AS(t6, i6.values), h4, e8)), i6;
  }
  var R = class {
    constructor(t6, i6) {
      this._$AV = [], this._$AN = void 0, this._$AD = t6, this._$AM = i6;
    }
    get parentNode() {
      return this._$AM.parentNode;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    u(t6) {
      const { el: { content: i6 }, parts: s5 } = this._$AD, e8 = (t6?.creationScope ?? l2).importNode(i6, true);
      P.currentNode = e8;
      let h4 = P.nextNode(), o9 = 0, n7 = 0, r8 = s5[0];
      for (; void 0 !== r8; ) {
        if (o9 === r8.index) {
          let i7;
          2 === r8.type ? i7 = new k(h4, h4.nextSibling, this, t6) : 1 === r8.type ? i7 = new r8.ctor(h4, r8.name, r8.strings, this, t6) : 6 === r8.type && (i7 = new Z(h4, this, t6)), this._$AV.push(i7), r8 = s5[++n7];
        }
        o9 !== r8?.index && (h4 = P.nextNode(), o9++);
      }
      return P.currentNode = l2, e8;
    }
    p(t6) {
      let i6 = 0;
      for (const s5 of this._$AV) void 0 !== s5 && (void 0 !== s5.strings ? (s5._$AI(t6, s5, i6), i6 += s5.strings.length - 2) : s5._$AI(t6[i6])), i6++;
    }
  };
  var k = class _k {
    get _$AU() {
      return this._$AM?._$AU ?? this._$Cv;
    }
    constructor(t6, i6, s5, e8) {
      this.type = 2, this._$AH = A, this._$AN = void 0, this._$AA = t6, this._$AB = i6, this._$AM = s5, this.options = e8, this._$Cv = e8?.isConnected ?? true;
    }
    get parentNode() {
      let t6 = this._$AA.parentNode;
      const i6 = this._$AM;
      return void 0 !== i6 && 11 === t6?.nodeType && (t6 = i6.parentNode), t6;
    }
    get startNode() {
      return this._$AA;
    }
    get endNode() {
      return this._$AB;
    }
    _$AI(t6, i6 = this) {
      t6 = M(this, t6, i6), a2(t6) ? t6 === A || null == t6 || "" === t6 ? (this._$AH !== A && this._$AR(), this._$AH = A) : t6 !== this._$AH && t6 !== E && this._(t6) : void 0 !== t6._$litType$ ? this.$(t6) : void 0 !== t6.nodeType ? this.T(t6) : d2(t6) ? this.k(t6) : this._(t6);
    }
    O(t6) {
      return this._$AA.parentNode.insertBefore(t6, this._$AB);
    }
    T(t6) {
      this._$AH !== t6 && (this._$AR(), this._$AH = this.O(t6));
    }
    _(t6) {
      this._$AH !== A && a2(this._$AH) ? this._$AA.nextSibling.data = t6 : this.T(l2.createTextNode(t6)), this._$AH = t6;
    }
    $(t6) {
      const { values: i6, _$litType$: s5 } = t6, e8 = "number" == typeof s5 ? this._$AC(t6) : (void 0 === s5.el && (s5.el = S2.createElement(V(s5.h, s5.h[0]), this.options)), s5);
      if (this._$AH?._$AD === e8) this._$AH.p(i6);
      else {
        const t7 = new R(e8, this), s6 = t7.u(this.options);
        t7.p(i6), this.T(s6), this._$AH = t7;
      }
    }
    _$AC(t6) {
      let i6 = C.get(t6.strings);
      return void 0 === i6 && C.set(t6.strings, i6 = new S2(t6)), i6;
    }
    k(t6) {
      u2(this._$AH) || (this._$AH = [], this._$AR());
      const i6 = this._$AH;
      let s5, e8 = 0;
      for (const h4 of t6) e8 === i6.length ? i6.push(s5 = new _k(this.O(c3()), this.O(c3()), this, this.options)) : s5 = i6[e8], s5._$AI(h4), e8++;
      e8 < i6.length && (this._$AR(s5 && s5._$AB.nextSibling, e8), i6.length = e8);
    }
    _$AR(t6 = this._$AA.nextSibling, s5) {
      for (this._$AP?.(false, true, s5); t6 !== this._$AB; ) {
        const s6 = i3(t6).nextSibling;
        i3(t6).remove(), t6 = s6;
      }
    }
    setConnected(t6) {
      void 0 === this._$AM && (this._$Cv = t6, this._$AP?.(t6));
    }
  };
  var H = class {
    get tagName() {
      return this.element.tagName;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    constructor(t6, i6, s5, e8, h4) {
      this.type = 1, this._$AH = A, this._$AN = void 0, this.element = t6, this.name = i6, this._$AM = e8, this.options = h4, s5.length > 2 || "" !== s5[0] || "" !== s5[1] ? (this._$AH = Array(s5.length - 1).fill(new String()), this.strings = s5) : this._$AH = A;
    }
    _$AI(t6, i6 = this, s5, e8) {
      const h4 = this.strings;
      let o9 = false;
      if (void 0 === h4) t6 = M(this, t6, i6, 0), o9 = !a2(t6) || t6 !== this._$AH && t6 !== E, o9 && (this._$AH = t6);
      else {
        const e9 = t6;
        let n7, r8;
        for (t6 = h4[0], n7 = 0; n7 < h4.length - 1; n7++) r8 = M(this, e9[s5 + n7], i6, n7), r8 === E && (r8 = this._$AH[n7]), o9 ||= !a2(r8) || r8 !== this._$AH[n7], r8 === A ? t6 = A : t6 !== A && (t6 += (r8 ?? "") + h4[n7 + 1]), this._$AH[n7] = r8;
      }
      o9 && !e8 && this.j(t6);
    }
    j(t6) {
      t6 === A ? this.element.removeAttribute(this.name) : this.element.setAttribute(this.name, t6 ?? "");
    }
  };
  var I = class extends H {
    constructor() {
      super(...arguments), this.type = 3;
    }
    j(t6) {
      this.element[this.name] = t6 === A ? void 0 : t6;
    }
  };
  var L = class extends H {
    constructor() {
      super(...arguments), this.type = 4;
    }
    j(t6) {
      this.element.toggleAttribute(this.name, !!t6 && t6 !== A);
    }
  };
  var z = class extends H {
    constructor(t6, i6, s5, e8, h4) {
      super(t6, i6, s5, e8, h4), this.type = 5;
    }
    _$AI(t6, i6 = this) {
      if ((t6 = M(this, t6, i6, 0) ?? A) === E) return;
      const s5 = this._$AH, e8 = t6 === A && s5 !== A || t6.capture !== s5.capture || t6.once !== s5.once || t6.passive !== s5.passive, h4 = t6 !== A && (s5 === A || e8);
      e8 && this.element.removeEventListener(this.name, this, s5), h4 && this.element.addEventListener(this.name, this, t6), this._$AH = t6;
    }
    handleEvent(t6) {
      "function" == typeof this._$AH ? this._$AH.call(this.options?.host ?? this.element, t6) : this._$AH.handleEvent(t6);
    }
  };
  var Z = class {
    constructor(t6, i6, s5) {
      this.element = t6, this.type = 6, this._$AN = void 0, this._$AM = i6, this.options = s5;
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AI(t6) {
      M(this, t6);
    }
  };
  var j = { M: h2, P: o3, A: n3, C: 1, L: N, R, D: d2, V: M, I: k, H, N: L, U: z, B: I, F: Z };
  var B = t2.litHtmlPolyfillSupport;
  B?.(S2, k), (t2.litHtmlVersions ??= []).push("3.3.2");
  var D = (t6, i6, s5) => {
    const e8 = s5?.renderBefore ?? i6;
    let h4 = e8._$litPart$;
    if (void 0 === h4) {
      const t7 = s5?.renderBefore ?? null;
      e8._$litPart$ = h4 = new k(i6.insertBefore(c3(), t7), t7, void 0, s5 ?? {});
    }
    return h4._$AI(t6), h4;
  };

  // node_modules/lit-element/lit-element.js
  var s3 = globalThis;
  var i4 = class extends y {
    constructor() {
      super(...arguments), this.renderOptions = { host: this }, this._$Do = void 0;
    }
    createRenderRoot() {
      const t6 = super.createRenderRoot();
      return this.renderOptions.renderBefore ??= t6.firstChild, t6;
    }
    update(t6) {
      const r8 = this.render();
      this.hasUpdated || (this.renderOptions.isConnected = this.isConnected), super.update(t6), this._$Do = D(r8, this.renderRoot, this.renderOptions);
    }
    connectedCallback() {
      super.connectedCallback(), this._$Do?.setConnected(true);
    }
    disconnectedCallback() {
      super.disconnectedCallback(), this._$Do?.setConnected(false);
    }
    render() {
      return E;
    }
  };
  i4._$litElement$ = true, i4["finalized"] = true, s3.litElementHydrateSupport?.({ LitElement: i4 });
  var o4 = s3.litElementPolyfillSupport;
  o4?.({ LitElement: i4 });
  (s3.litElementVersions ??= []).push("4.2.2");

  // node_modules/@lit/reactive-element/decorators/custom-element.js
  var t3 = (t6) => (e8, o9) => {
    void 0 !== o9 ? o9.addInitializer(() => {
      customElements.define(t6, e8);
    }) : customElements.define(t6, e8);
  };

  // node_modules/@lit/reactive-element/decorators/property.js
  var o5 = { attribute: true, type: String, converter: u, reflect: false, hasChanged: f };
  var r4 = (t6 = o5, e8, r8) => {
    const { kind: n7, metadata: i6 } = r8;
    let s5 = globalThis.litPropertyMetadata.get(i6);
    if (void 0 === s5 && globalThis.litPropertyMetadata.set(i6, s5 = /* @__PURE__ */ new Map()), "setter" === n7 && ((t6 = Object.create(t6)).wrapped = true), s5.set(r8.name, t6), "accessor" === n7) {
      const { name: o9 } = r8;
      return { set(r9) {
        const n8 = e8.get.call(this);
        e8.set.call(this, r9), this.requestUpdate(o9, n8, t6, true, r9);
      }, init(e9) {
        return void 0 !== e9 && this.C(o9, void 0, t6, e9), e9;
      } };
    }
    if ("setter" === n7) {
      const { name: o9 } = r8;
      return function(r9) {
        const n8 = this[o9];
        e8.call(this, r9), this.requestUpdate(o9, n8, t6, true, r9);
      };
    }
    throw Error("Unsupported decorator location: " + n7);
  };
  function n4(t6) {
    return (e8, o9) => "object" == typeof o9 ? r4(t6, e8, o9) : ((t7, e9, o10) => {
      const r8 = e9.hasOwnProperty(o10);
      return e9.constructor.createProperty(o10, t7), r8 ? Object.getOwnPropertyDescriptor(e9, o10) : void 0;
    })(t6, e8, o9);
  }

  // node_modules/@lit/reactive-element/decorators/state.js
  function r5(r8) {
    return n4({ ...r8, state: true, attribute: false });
  }

  // node_modules/lit-html/directive-helpers.js
  var { I: t4 } = j;
  var r6 = (o9) => void 0 === o9.strings;

  // node_modules/lit-html/directive.js
  var t5 = { ATTRIBUTE: 1, CHILD: 2, PROPERTY: 3, BOOLEAN_ATTRIBUTE: 4, EVENT: 5, ELEMENT: 6 };
  var e5 = (t6) => (...e8) => ({ _$litDirective$: t6, values: e8 });
  var i5 = class {
    constructor(t6) {
    }
    get _$AU() {
      return this._$AM._$AU;
    }
    _$AT(t6, e8, i6) {
      this._$Ct = t6, this._$AM = e8, this._$Ci = i6;
    }
    _$AS(t6, e8) {
      return this.update(t6, e8);
    }
    update(t6, e8) {
      return this.render(...e8);
    }
  };

  // node_modules/lit-html/async-directive.js
  var s4 = (i6, t6) => {
    const e8 = i6._$AN;
    if (void 0 === e8) return false;
    for (const i7 of e8) i7._$AO?.(t6, false), s4(i7, t6);
    return true;
  };
  var o6 = (i6) => {
    let t6, e8;
    do {
      if (void 0 === (t6 = i6._$AM)) break;
      e8 = t6._$AN, e8.delete(i6), i6 = t6;
    } while (0 === e8?.size);
  };
  var r7 = (i6) => {
    for (let t6; t6 = i6._$AM; i6 = t6) {
      let e8 = t6._$AN;
      if (void 0 === e8) t6._$AN = e8 = /* @__PURE__ */ new Set();
      else if (e8.has(i6)) break;
      e8.add(i6), c4(t6);
    }
  };
  function h3(i6) {
    void 0 !== this._$AN ? (o6(this), this._$AM = i6, r7(this)) : this._$AM = i6;
  }
  function n5(i6, t6 = false, e8 = 0) {
    const r8 = this._$AH, h4 = this._$AN;
    if (void 0 !== h4 && 0 !== h4.size) if (t6) if (Array.isArray(r8)) for (let i7 = e8; i7 < r8.length; i7++) s4(r8[i7], false), o6(r8[i7]);
    else null != r8 && (s4(r8, false), o6(r8));
    else s4(this, i6);
  }
  var c4 = (i6) => {
    i6.type == t5.CHILD && (i6._$AP ??= n5, i6._$AQ ??= h3);
  };
  var f3 = class extends i5 {
    constructor() {
      super(...arguments), this._$AN = void 0;
    }
    _$AT(i6, t6, e8) {
      super._$AT(i6, t6, e8), r7(this), this.isConnected = i6._$AU;
    }
    _$AO(i6, t6 = true) {
      i6 !== this.isConnected && (this.isConnected = i6, i6 ? this.reconnected?.() : this.disconnected?.()), t6 && (s4(this, i6), o6(this));
    }
    setValue(t6) {
      if (r6(this._$Ct)) this._$Ct._$AI(t6, this);
      else {
        const i6 = [...this._$Ct._$AH];
        i6[this._$Ci] = t6, this._$Ct._$AI(i6, this, 0);
      }
    }
    disconnected() {
    }
    reconnected() {
    }
  };

  // node_modules/lit-html/directives/ref.js
  var o7 = /* @__PURE__ */ new WeakMap();
  var n6 = e5(class extends f3 {
    render(i6) {
      return A;
    }
    update(i6, [s5]) {
      const e8 = s5 !== this.G;
      return e8 && void 0 !== this.G && this.rt(void 0), (e8 || this.lt !== this.ct) && (this.G = s5, this.ht = i6.options?.host, this.rt(this.ct = i6.element)), A;
    }
    rt(t6) {
      if (this.isConnected || (t6 = void 0), "function" == typeof this.G) {
        const i6 = this.ht ?? globalThis;
        let s5 = o7.get(i6);
        void 0 === s5 && (s5 = /* @__PURE__ */ new WeakMap(), o7.set(i6, s5)), void 0 !== s5.get(this.G) && this.G.call(this.ht, void 0), s5.set(this.G, t6), void 0 !== t6 && this.G.call(this.ht, t6);
      } else this.G.value = t6;
    }
    get lt() {
      return "function" == typeof this.G ? o7.get(this.ht ?? globalThis)?.get(this.G) : this.G?.value;
    }
    disconnected() {
      this.lt === this.ct && this.rt(void 0);
    }
    reconnected() {
      this.rt(this.ct);
    }
  });

  // node_modules/@mariozechner/mini-lit/dist/i18n.js
  var defaultEnglish = {
    "*": "*",
    Copy: "Copy",
    "Copy code": "Copy code",
    "Copied!": "Copied!",
    Download: "Download",
    Close: "Close",
    Preview: "Preview",
    Code: "Code",
    "Loading...": "Loading...",
    "Select an option": "Select an option",
    "Mode 1": "Mode 1",
    "Mode 2": "Mode 2",
    Required: "Required",
    Optional: "Optional",
    "Input Required": "Input Required",
    Cancel: "Cancel",
    Confirm: "Confirm"
  };
  var defaultGerman = {
    "*": "*",
    Copy: "Kopieren",
    "Copy code": "Code kopieren",
    "Copied!": "Kopiert!",
    Download: "Herunterladen",
    Close: "Schlie\xDFen",
    Preview: "Vorschau",
    Code: "Code",
    "Loading...": "Laden...",
    "Select an option": "Option ausw\xE4hlen",
    "Mode 1": "Modus 1",
    "Mode 2": "Modus 2",
    Required: "Erforderlich",
    Optional: "Optional",
    "Input Required": "Eingabe erforderlich",
    Cancel: "Abbrechen",
    Confirm: "Best\xE4tigen"
  };
  var userTranslations = null;
  var translations = {
    en: defaultEnglish,
    de: defaultGerman
  };
  function setTranslations(customTranslations) {
    userTranslations = customTranslations;
    translations = customTranslations;
  }
  function getCurrentLanguage() {
    const stored = localStorage.getItem("language");
    if (stored && translations[stored]) {
      return stored;
    }
    const userLocale = navigator.language || navigator.userLanguage;
    const languageCode = userLocale ? userLocale.split("-")[0] : "en";
    return translations[languageCode] ? languageCode : "en";
  }
  function i18n(categoryOrKey, key) {
    const languageCode = getCurrentLanguage();
    const implementation = translations[languageCode] || translations.en;
    if (key === void 0) {
      const value = implementation[categoryOrKey];
      if (!value) {
        if (typeof value === "function") {
          return value;
        }
        console.error(`Unknown i18n key: ${categoryOrKey}`);
        return categoryOrKey;
      }
      return value;
    } else {
      const category = implementation[categoryOrKey];
      if (!category || typeof category !== "object") {
        console.error(`Unknown i18n category: ${categoryOrKey}`);
        return key;
      }
      const value = category[key];
      if (!value) {
        console.error(`Unknown i18n key: ${categoryOrKey}.${key}`);
        return key;
      }
      return value;
    }
  }

  // node_modules/lit-html/directives/unsafe-html.js
  var e7 = class extends i5 {
    constructor(i6) {
      if (super(i6), this.it = A, i6.type !== t5.CHILD) throw Error(this.constructor.directiveName + "() can only be used in child bindings");
    }
    render(r8) {
      if (r8 === A || null == r8) return this._t = void 0, this.it = r8;
      if (r8 === E) return r8;
      if ("string" != typeof r8) throw Error(this.constructor.directiveName + "() called with a non-string value");
      if (r8 === this.it) return this._t;
      this.it = r8;
      const s5 = [r8];
      return s5.raw = s5, this._t = { _$litType$: this.constructor.resultType, strings: s5, values: [] };
    }
  };
  e7.directiveName = "unsafeHTML", e7.resultType = 1;
  var o8 = e5(e7);

  // node_modules/lucide/dist/esm/defaultAttributes.js
  var defaultAttributes = {
    xmlns: "http://www.w3.org/2000/svg",
    width: 24,
    height: 24,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    "stroke-width": 2,
    "stroke-linecap": "round",
    "stroke-linejoin": "round"
  };

  // node_modules/lucide/dist/esm/createElement.js
  var createSVGElement = ([tag, attrs, children]) => {
    const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
    Object.keys(attrs).forEach((name) => {
      element.setAttribute(name, String(attrs[name]));
    });
    if (children?.length) {
      children.forEach((child) => {
        const childElement = createSVGElement(child);
        element.appendChild(childElement);
      });
    }
    return element;
  };
  var createElement = (iconNode, customAttrs = {}) => {
    const tag = "svg";
    const attrs = {
      ...defaultAttributes,
      ...customAttrs
    };
    return createSVGElement([tag, attrs, iconNode]);
  };

  // node_modules/lucide/dist/esm/icons/check.js
  var Check = [["path", { d: "M20 6 9 17l-5-5" }]];

  // node_modules/lucide/dist/esm/icons/columns-2.js
  var Columns2 = [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M12 3v18" }]
  ];

  // node_modules/lucide/dist/esm/icons/copy.js
  var Copy = [
    ["rect", { width: "14", height: "14", x: "8", y: "8", rx: "2", ry: "2" }],
    ["path", { d: "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" }]
  ];

  // node_modules/lucide/dist/esm/icons/rows-2.js
  var Rows2 = [
    ["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
    ["path", { d: "M3 12h18" }]
  ];

  // node_modules/@mariozechner/mini-lit/dist/icons.js
  var sizeClasses = {
    xs: "w-3 h-3",
    sm: "w-4 h-4",
    md: "w-5 h-5",
    lg: "w-6 h-6",
    xl: "w-8 h-8"
  };
  function icon(lucideIcon, size = "md", className) {
    return b2`${o8(iconDOM(lucideIcon, size, className).outerHTML)}`;
  }
  function iconDOM(lucideIcon, size = "md", className) {
    const element = createElement(lucideIcon, {
      class: sizeClasses[size] + (className ? " " + className : "")
    });
    return element;
  }

  // src/ui/utils/i18n.ts
  var translations2 = {
    en: {
      ...defaultEnglish,
      Free: "Free",
      "Input Required": "Input Required",
      Cancel: "Cancel",
      Confirm: "Confirm",
      "Select Model": "Select Model",
      "Search models...": "Search models...",
      Format: "Format",
      Thinking: "Thinking",
      Vision: "Vision",
      You: "You",
      Assistant: "Assistant",
      "Thinking...": "Thinking...",
      "Type your message...": "Type your message...",
      "API Keys Configuration": "API Keys Configuration",
      "Configure API keys for LLM providers. Keys are stored locally in your browser.": "Configure API keys for LLM providers. Keys are stored locally in your browser.",
      Configured: "Configured",
      "Not configured": "Not configured",
      "\u2713 Valid": "\u2713 Valid",
      "\u2717 Invalid": "\u2717 Invalid",
      "Testing...": "Testing...",
      Update: "Update",
      Test: "Test",
      Remove: "Remove",
      Save: "Save",
      "Update API key": "Update API key",
      "Enter API key": "Enter API key",
      "Type a message...": "Type a message...",
      "Failed to fetch file": "Failed to fetch file",
      "Invalid source type": "Invalid source type",
      PDF: "PDF",
      Document: "Document",
      Presentation: "Presentation",
      Spreadsheet: "Spreadsheet",
      Text: "Text",
      "Error loading file": "Error loading file",
      "No text content available": "No text content available",
      "Failed to load PDF": "Failed to load PDF",
      "Failed to load document": "Failed to load document",
      "Failed to load spreadsheet": "Failed to load spreadsheet",
      "Error loading PDF": "Error loading PDF",
      "Error loading document": "Error loading document",
      "Error loading spreadsheet": "Error loading spreadsheet",
      "Preview not available for this file type.": "Preview not available for this file type.",
      "Click the download button above to view it on your computer.": "Click the download button above to view it on your computer.",
      "No content available": "No content available",
      "Failed to display text content": "Failed to display text content",
      "API keys are required to use AI models. Get your keys from the provider's website.": "API keys are required to use AI models. Get your keys from the provider's website.",
      console: "console",
      diff: "diff",
      "Copy output": "Copy output",
      "Copied!": "Copied!",
      "Error:": "Error:",
      "Request aborted": "Request aborted",
      Call: "Call",
      Result: "Result",
      "(no result)": "(no result)",
      "Waiting for tool result\u2026": "Waiting for tool result\u2026",
      "Call was aborted; no result.": "Call was aborted; no result.",
      "No session available": "No session available",
      "No session set": "No session set",
      "Preparing tool parameters...": "Preparing tool parameters...",
      "(no output)": "(no output)",
      Input: "Input",
      Output: "Output",
      "Waiting for expression...": "Waiting for expression...",
      "Writing expression...": "Writing expression...",
      Calculating: "Calculating",
      "Getting current time in": "Getting current time in",
      "Getting current date and time": "Getting current date and time",
      "Waiting for command...": "Waiting for command...",
      "Writing command...": "Writing command...",
      "Running command...": "Running command...",
      "Command failed": "Command failed",
      "Enter Auth Token": "Enter Auth Token",
      "Please enter your auth token.": "Please enter your auth token.",
      "Auth token is required for proxy transport": "Auth token is required for proxy transport",
      // JavaScript REPL strings
      "Execution aborted": "Execution aborted",
      "Code parameter is required": "Code parameter is required",
      "Unknown error": "Unknown error",
      "Code executed successfully (no output)": "Code executed successfully (no output)",
      "Execution failed": "Execution failed",
      "JavaScript REPL": "JavaScript REPL",
      "JavaScript code to execute": "JavaScript code to execute",
      "Writing JavaScript code...": "Writing JavaScript code...",
      "Executing JavaScript": "Executing JavaScript",
      "Preparing JavaScript...": "Preparing JavaScript...",
      "Preparing command...": "Preparing command...",
      "Preparing calculation...": "Preparing calculation...",
      "Preparing tool...": "Preparing tool...",
      "Getting time...": "Getting time...",
      // Artifacts strings
      "Processing artifact...": "Processing artifact...",
      "Preparing artifact...": "Preparing artifact...",
      "Processing artifact": "Processing artifact",
      "Processed artifact": "Processed artifact",
      "Creating artifact": "Creating artifact",
      "Created artifact": "Created artifact",
      "Updating artifact": "Updating artifact",
      "Updated artifact": "Updated artifact",
      "Rewriting artifact": "Rewriting artifact",
      "Rewrote artifact": "Rewrote artifact",
      "Getting artifact": "Getting artifact",
      "Got artifact": "Got artifact",
      "Deleting artifact": "Deleting artifact",
      "Deleted artifact": "Deleted artifact",
      "Getting logs": "Getting logs",
      "Got logs": "Got logs",
      "An error occurred": "An error occurred",
      "Copy logs": "Copy logs",
      "Autoscroll enabled": "Autoscroll enabled",
      "Autoscroll disabled": "Autoscroll disabled",
      Processing: "Processing",
      Create: "Create",
      Rewrite: "Rewrite",
      Get: "Get",
      "Get logs": "Get logs",
      "Show artifacts": "Show artifacts",
      "Close artifacts": "Close artifacts",
      Artifacts: "Artifacts",
      "Copy HTML": "Copy HTML",
      "Download HTML": "Download HTML",
      "Reload HTML": "Reload HTML",
      "Copy SVG": "Copy SVG",
      "Download SVG": "Download SVG",
      "Copy Markdown": "Copy Markdown",
      "Download Markdown": "Download Markdown",
      Download: "Download",
      "No logs for {filename}": "No logs for {filename}",
      "API Keys Settings": "API Keys Settings",
      Settings: "Settings",
      "API Keys": "API Keys",
      Proxy: "Proxy",
      "Use CORS Proxy": "Use CORS Proxy",
      "Proxy URL": "Proxy URL",
      "Format: The proxy must accept requests as <proxy-url>/?url=<target-url>": "Format: The proxy must accept requests as <proxy-url>/?url=<target-url>",
      "Settings are stored locally in your browser": "Settings are stored locally in your browser",
      Clear: "Clear",
      "API Key Required": "API Key Required",
      "Enter your API key for {provider}": "Enter your API key for {provider}",
      "Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.": "Allows browser-based apps to bypass CORS restrictions when calling LLM providers. Required for Z-AI and Anthropic with OAuth token.",
      Off: "Off",
      Minimal: "Minimal",
      Low: "Low",
      Medium: "Medium",
      High: "High",
      "Storage Permission Required": "Storage Permission Required",
      "This app needs persistent storage to save your conversations": "This app needs persistent storage to save your conversations",
      "Why is this needed?": "Why is this needed?",
      "Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.": "Without persistent storage, your browser may delete saved conversations when it needs disk space. Granting this permission ensures your chat history is preserved.",
      "What this means:": "What this means:",
      "Your conversations will be saved locally in your browser": "Your conversations will be saved locally in your browser",
      "Data will not be deleted automatically to free up space": "Data will not be deleted automatically to free up space",
      "You can still manually clear data at any time": "You can still manually clear data at any time",
      "No data is sent to external servers": "No data is sent to external servers",
      "Continue Anyway": "Continue Anyway",
      "Requesting...": "Requesting...",
      "Grant Permission": "Grant Permission",
      Sessions: "Sessions",
      "Load a previous conversation": "Load a previous conversation",
      "No sessions yet": "No sessions yet",
      "Delete this session?": "Delete this session?",
      Today: "Today",
      Yesterday: "Yesterday",
      "{days} days ago": "{days} days ago",
      messages: "messages",
      tokens: "tokens",
      Delete: "Delete",
      "Drop files here": "Drop files here",
      "Command failed:": "Command failed:",
      // Providers & Models
      "Providers & Models": "Providers & Models",
      "Cloud Providers": "Cloud Providers",
      "Cloud LLM providers with predefined models. API keys are stored locally in your browser.": "Cloud LLM providers with predefined models. API keys are stored locally in your browser.",
      "Custom Providers": "Custom Providers",
      "User-configured servers with auto-discovered or manually defined models.": "User-configured servers with auto-discovered or manually defined models.",
      "Add Provider": "Add Provider",
      "No custom providers configured. Click 'Add Provider' to get started.": "No custom providers configured. Click 'Add Provider' to get started.",
      "auto-discovered": "auto-discovered",
      Refresh: "Refresh",
      Edit: "Edit",
      "Are you sure you want to delete this provider?": "Are you sure you want to delete this provider?",
      "Edit Provider": "Edit Provider",
      "Provider Name": "Provider Name",
      "e.g., My Ollama Server": "e.g., My Ollama Server",
      "Provider Type": "Provider Type",
      "Base URL": "Base URL",
      "e.g., http://localhost:11434": "e.g., http://localhost:11434",
      "API Key (Optional)": "API Key (Optional)",
      "Leave empty if not required": "Leave empty if not required",
      "Test Connection": "Test Connection",
      Discovered: "Discovered",
      Models: "Models",
      models: "models",
      and: "and",
      more: "more",
      "For manual provider types, add models after saving the provider.": "For manual provider types, add models after saving the provider.",
      "Please fill in all required fields": "Please fill in all required fields",
      "Failed to save provider": "Failed to save provider",
      "OpenAI Completions Compatible": "OpenAI Completions Compatible",
      "OpenAI Responses Compatible": "OpenAI Responses Compatible",
      "Anthropic Messages Compatible": "Anthropic Messages Compatible",
      "Checking...": "Checking...",
      Disconnected: "Disconnected",
      "API key required": "API key required",
      "API key required \u2014 set up in Settings > Providers": "API key required \u2014 set up in Settings > Providers",
      // Coding tool renderers
      Screenshot: "Screenshot",
      "Full page screenshot": "Full page screenshot",
      Reading: "Reading",
      "Reading file...": "Reading file...",
      Writing: "Writing",
      "Writing file...": "Writing file...",
      Editing: "Editing",
      "Editing file...": "Editing file...",
      Listing: "Listing",
      "Listing directory...": "Listing directory...",
      Finding: "Finding",
      "Finding files...": "Finding files...",
      in: "in",
      "Searching for": "Searching for",
      "Searching...": "Searching...",
      Preparing: "Preparing"
    }
  };
  setTranslations(translations2);

  // src/ui/components/DiffBlock.ts
  function parseDiff(raw) {
    const files = [];
    const lines = raw.split("\n");
    let i6 = 0;
    while (i6 < lines.length) {
      if (!lines[i6].startsWith("diff --git ")) {
        i6++;
        continue;
      }
      const diffLine = lines[i6];
      const match = diffLine.match(/^diff --git a\/(.+?) b\/(.+)$/);
      const header = match ? match[1] === match[2] ? match[1] : `${match[1]} \u2192 ${match[2]}` : diffLine;
      i6++;
      while (i6 < lines.length && !lines[i6].startsWith("@@") && !lines[i6].startsWith("diff --git ")) {
        i6++;
      }
      const hunks = [];
      while (i6 < lines.length && !lines[i6].startsWith("diff --git ")) {
        if (!lines[i6].startsWith("@@")) {
          i6++;
          continue;
        }
        const hunkHeader = lines[i6];
        const hunkMatch = hunkHeader.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        let oldLine = hunkMatch ? parseInt(hunkMatch[1]) : 1;
        let newLine = hunkMatch ? parseInt(hunkMatch[2]) : 1;
        i6++;
        const hunkLines = [];
        while (i6 < lines.length && !lines[i6].startsWith("@@") && !lines[i6].startsWith("diff --git ")) {
          const line = lines[i6];
          if (line.startsWith("+")) {
            hunkLines.push({ type: "add", content: line.slice(1), oldLineNo: null, newLineNo: newLine++ });
          } else if (line.startsWith("-")) {
            hunkLines.push({ type: "remove", content: line.slice(1), oldLineNo: oldLine++, newLineNo: null });
          } else if (line.startsWith(" ") || line === "") {
            hunkLines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
          } else if (line.startsWith("\\")) {
          } else {
            break;
          }
          i6++;
        }
        hunks.push({ header: hunkHeader, lines: hunkLines });
      }
      files.push({ header, hunks });
    }
    return files;
  }
  function buildSidePairs(lines) {
    const pairs = [];
    let i6 = 0;
    while (i6 < lines.length) {
      const line = lines[i6];
      if (line.type === "context") {
        pairs.push({ left: line, right: line });
        i6++;
      } else if (line.type === "remove") {
        const removes = [];
        while (i6 < lines.length && lines[i6].type === "remove") {
          removes.push(lines[i6]);
          i6++;
        }
        const adds = [];
        while (i6 < lines.length && lines[i6].type === "add") {
          adds.push(lines[i6]);
          i6++;
        }
        const max = Math.max(removes.length, adds.length);
        for (let j2 = 0; j2 < max; j2++) {
          pairs.push({
            left: j2 < removes.length ? removes[j2] : null,
            right: j2 < adds.length ? adds[j2] : null
          });
        }
      } else if (line.type === "add") {
        pairs.push({ left: null, right: line });
        i6++;
      }
    }
    return pairs;
  }
  var MOBILE_BREAKPOINT = 768;
  var DiffBlock = class extends i4 {
    constructor() {
      super(...arguments);
      this.content = "";
      this.copied = false;
      this.viewMode = null;
      this.windowWidth = typeof window !== "undefined" ? window.innerWidth : 1024;
      this._resizeHandler = () => {
        this.windowWidth = window.innerWidth;
      };
    }
    createRenderRoot() {
      return this;
    }
    connectedCallback() {
      super.connectedCallback();
      this.style.display = "block";
      window.addEventListener("resize", this._resizeHandler);
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      window.removeEventListener("resize", this._resizeHandler);
    }
    get effectiveMode() {
      if (this.viewMode) return this.viewMode;
      return this.windowWidth >= MOBILE_BREAKPOINT ? "side-by-side" : "inline";
    }
    async copy() {
      try {
        await navigator.clipboard.writeText(this.content || "");
        this.copied = true;
        setTimeout(() => {
          this.copied = false;
        }, 1500);
      } catch (e8) {
        console.error("Copy failed", e8);
      }
    }
    toggleMode() {
      this.viewMode = this.effectiveMode === "side-by-side" ? "inline" : "side-by-side";
    }
    // ── Rendering helpers ────────────────────────────────────────────
    renderLineNo(n7) {
      return b2`<span class="diff-lineno select-none text-muted-foreground/50 text-right pr-2 shrink-0" style="min-width:3ch;display:inline-block">${n7 ?? ""}</span>`;
    }
    lineClass(type) {
      switch (type) {
        case "add":
          return "bg-green-500/15 text-green-700 dark:text-green-400";
        case "remove":
          return "bg-red-500/15 text-red-700 dark:text-red-400";
        default:
          return "";
      }
    }
    linePrefix(type) {
      switch (type) {
        case "add":
          return "+";
        case "remove":
          return "-";
        default:
          return " ";
      }
    }
    renderInline(files) {
      return b2`${files.map((file) => b2`
			<div class="diff-file">
				<div class="px-3 py-1 bg-muted/50 text-xs font-mono text-muted-foreground border-b border-border font-medium">${file.header}</div>
				${file.hunks.map((hunk) => b2`
					<div class="diff-hunk">
						<div class="px-3 py-0.5 bg-blue-500/10 text-xs font-mono text-blue-600 dark:text-blue-400 border-b border-border/50">${hunk.header}</div>
						${hunk.lines.map((line) => b2`
							<div class="flex font-mono text-xs leading-5 ${this.lineClass(line.type)} hover:brightness-95 dark:hover:brightness-110">
								${this.renderLineNo(line.oldLineNo)}
								${this.renderLineNo(line.newLineNo)}
								<span class="select-none shrink-0 w-4 text-center ${line.type === "add" ? "text-green-600 dark:text-green-500" : line.type === "remove" ? "text-red-600 dark:text-red-500" : "text-muted-foreground/30"}">${this.linePrefix(line.type)}</span>
								<span class="flex-1 whitespace-pre overflow-x-auto pr-3">${line.content}</span>
							</div>
						`)}
					</div>
				`)}
			</div>
		`)}`;
    }
    renderSideBySide(files) {
      return b2`${files.map((file) => b2`
			<div class="diff-file">
				<div class="px-3 py-1 bg-muted/50 text-xs font-mono text-muted-foreground border-b border-border font-medium">${file.header}</div>
				${file.hunks.map((hunk) => {
        const pairs = buildSidePairs(hunk.lines);
        return b2`
						<div class="diff-hunk">
							<div class="px-3 py-0.5 bg-blue-500/10 text-xs font-mono text-blue-600 dark:text-blue-400 border-b border-border/50">${hunk.header}</div>
							${pairs.map((pair) => b2`
								<div class="flex font-mono text-xs leading-5">
									<div class="flex flex-1 min-w-0 ${pair.left ? this.lineClass(pair.left.type) : ""} border-r border-border/30 hover:brightness-95 dark:hover:brightness-110">
										${this.renderLineNo(pair.left?.oldLineNo ?? null)}
										<span class="select-none shrink-0 w-4 text-center ${pair.left?.type === "remove" ? "text-red-600 dark:text-red-500" : "text-muted-foreground/30"}">${pair.left ? this.linePrefix(pair.left.type) : " "}</span>
										<span class="flex-1 whitespace-pre overflow-x-auto pr-2">${pair.left?.content ?? ""}</span>
									</div>
									<div class="flex flex-1 min-w-0 ${pair.right ? this.lineClass(pair.right.type) : ""} hover:brightness-95 dark:hover:brightness-110">
										${this.renderLineNo(pair.right?.newLineNo ?? null)}
										<span class="select-none shrink-0 w-4 text-center ${pair.right?.type === "add" ? "text-green-600 dark:text-green-500" : "text-muted-foreground/30"}">${pair.right ? this.linePrefix(pair.right.type) : " "}</span>
										<span class="flex-1 whitespace-pre overflow-x-auto pr-2">${pair.right?.content ?? ""}</span>
									</div>
								</div>
							`)}
						</div>
					`;
      })}
			</div>
		`)}`;
    }
    render() {
      const files = parseDiff(this.content);
      if (files.length === 0) {
        return b2`<console-block .content=${this.content}></console-block>`;
      }
      const mode = this.effectiveMode;
      const isSideBySide = mode === "side-by-side";
      return b2`
			<div class="border border-border rounded-lg overflow-hidden">
				<div class="flex items-center justify-between px-3 py-1.5 bg-muted border-b border-border">
					<span class="text-xs text-muted-foreground font-mono">${i18n("diff")} · ${files.length} file${files.length !== 1 ? "s" : ""}</span>
					<div class="flex items-center gap-1">
						<button
							@click=${() => this.toggleMode()}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="${isSideBySide ? "Switch to inline view" : "Switch to side-by-side view"}"
						>
							${isSideBySide ? icon(Rows2, "sm") : icon(Columns2, "sm")}
						</button>
						<button
							@click=${() => this.copy()}
							class="flex items-center gap-1 px-2 py-0.5 text-xs rounded hover:bg-accent text-muted-foreground hover:text-accent-foreground transition-colors"
							title="${i18n("Copy output")}"
						>
							${this.copied ? icon(Check, "sm") : icon(Copy, "sm")}
							${this.copied ? b2`<span>${i18n("Copied!")}</span>` : ""}
						</button>
					</div>
				</div>
				<div class="overflow-auto max-h-[600px]">
					${isSideBySide ? this.renderSideBySide(files) : this.renderInline(files)}
				</div>
			</div>
		`;
    }
  };
  __decorateClass([
    n4()
  ], DiffBlock.prototype, "content", 2);
  __decorateClass([
    r5()
  ], DiffBlock.prototype, "copied", 2);
  __decorateClass([
    r5()
  ], DiffBlock.prototype, "viewMode", 2);
  __decorateClass([
    r5()
  ], DiffBlock.prototype, "windowWidth", 2);
  if (!customElements.get("diff-block")) {
    customElements.define("diff-block", DiffBlock);
  }

  // src/ui/components/GitStatusWidget.ts
  var GitStatusWidget = class extends i4 {
    constructor() {
      super(...arguments);
      this.branch = "";
      this.primaryBranch = "master";
      this.isOnPrimary = true;
      this.summary = "";
      this.clean = true;
      this.hasUpstream = false;
      this.ahead = 0;
      this.behind = 0;
      this.aheadOfPrimary = 0;
      this.behindPrimary = 0;
      this.mergedIntoPrimary = false;
      this.unpushed = false;
      this.statusFiles = [];
      this.loading = false;
      this.partial = false;
      this.sessionId = "";
      this.goalId = "";
      this.token = "";
      this.viewerIsAdmin = false;
      this._modalFile = null;
      this._loadingDiff = null;
      this._diffContent = null;
      this._diffError = null;
      this._commitsLoading = false;
      this._commits = [];
      this._commitsError = null;
      this._commitsDirection = "ahead";
      this._modalEl = null;
      this._commitsModalEl = null;
      this._onEscapeKey = (e8) => {
        if (e8.key === "Escape") {
          if (this._commitsModalEl) this._closeCommitsModal();
          else if (this._modalEl) this._closeModal();
        }
      };
      this.expanded = false;
      this.merging = false;
      this.mergeError = "";
      this.mergeMethod = "squash";
      this.pulling = false;
      this.pullError = "";
      this.pushing = false;
      this.pushError = "";
      this.mergingPrimary = false;
      this.mergePrimaryError = "";
      this._dropdownEl = null;
      this._closing = false;
      this._onDocumentClick = (e8) => {
        const target = e8.target;
        if (this.expanded && !this._closing && !this.contains(target) && !this._dropdownEl?.contains(target)) {
          this._closeDropdown();
        }
      };
      this._onEscapeKeyDropdown = (e8) => {
        if (e8.key === "Escape" && this.expanded && !this._closing && !this._modalEl && !this._commitsModalEl) {
          e8.stopPropagation();
          this._closeDropdown();
        }
      };
      this.squashPushing = false;
      this.squashPushError = "";
    }
    _closeDropdown() {
      if (this._closing || !this._dropdownEl) return;
      this._closing = true;
      this._dropdownEl.classList.add("git-dropdown-closing");
      this._dropdownEl.addEventListener("animationend", () => {
        this._closing = false;
        this.expanded = false;
      }, { once: true });
    }
    createRenderRoot() {
      return this;
    }
    connectedCallback() {
      super.connectedCallback();
      document.addEventListener("click", this._onDocumentClick, true);
      document.addEventListener("keydown", this._onEscapeKeyDropdown, true);
    }
    disconnectedCallback() {
      super.disconnectedCallback();
      document.removeEventListener("click", this._onDocumentClick, true);
      document.removeEventListener("keydown", this._onEscapeKeyDropdown, true);
      this._removeDropdown();
      this._removeModal();
      this._removeCommitsModal();
    }
    _removeDropdown() {
      if (this._dropdownEl) {
        this._dropdownEl.remove();
        this._dropdownEl = null;
      }
    }
    _toggle(e8) {
      e8.stopPropagation();
      if (this.loading && !this.branch) return;
      if (this.expanded && !this._closing) {
        this._closeDropdown();
      } else if (!this.expanded) {
        this.expanded = true;
        this.dispatchEvent(new CustomEvent("git-fetch", {
          bubbles: true,
          composed: true
        }));
        this.dispatchEvent(new CustomEvent("git-status-dropdown-open", {
          bubbles: true,
          composed: true
        }));
      }
    }
    _statusColor(status) {
      switch (status) {
        case "M":
          return "text-amber-600 dark:text-amber-400";
        case "A":
          return "text-green-600 dark:text-green-400";
        case "D":
          return "text-red-600 dark:text-red-400";
        case "?":
          return "text-muted-foreground";
        case "R":
          return "text-blue-600 dark:text-blue-400";
        case "U":
          return "text-red-700 dark:text-red-500";
        default:
          return "text-muted-foreground";
      }
    }
    _statusLabel(status) {
      switch (status) {
        case "M":
          return "modified";
        case "A":
          return "added";
        case "D":
          return "deleted";
        case "?":
          return "untracked";
        case "R":
          return "renamed";
        case "U":
          return "unmerged";
        default:
          return status;
      }
    }
    /** Pill segments: ~N dirty, ↓N behind primary (red), ↑N ahead primary (blue) */
    _pillSegments() {
      const segments = [];
      if (!this.clean && this.statusFiles.length > 0) {
        segments.push(b2`<span class="text-amber-600 dark:text-amber-400 shrink-0" style="font-weight:500">~${this.statusFiles.length}</span>`);
      }
      if (!this.isOnPrimary && this.behindPrimary > 0) {
        segments.push(b2`<span class="text-red-600 dark:text-red-400 shrink-0" style="font-weight:500">↓${this.behindPrimary}</span>`);
      }
      if (!this.isOnPrimary && this.aheadOfPrimary > 0) {
        segments.push(b2`<span class="text-blue-600 dark:text-blue-400 shrink-0" style="font-weight:500">↑${this.aheadOfPrimary}</span>`);
      }
      return segments;
    }
    _renderRemoteStatus() {
      if (!this.isOnPrimary) return A;
      if (this.ahead > 0 && this.behind > 0) {
        return b2`<div class="text-muted-foreground">
                Remote: <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("ahead");
        }}>${this.ahead} ahead</span>,
                <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("behind");
        }}>${this.behind} behind</span>
                ${this._renderPullButton()}
            </div>`;
      }
      if (this.ahead > 0) {
        return b2`<div class="text-muted-foreground">
                <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("ahead");
        }}>${this.ahead} unpushed</span> to remote
                ${this._renderPushButton()}
            </div>`;
      }
      if (this.behind > 0) {
        return b2`<div class="text-muted-foreground">
                <span class="text-amber-600 dark:text-amber-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("behind");
        }}>${this.behind} behind</span> remote
                ${this._renderPullButton()}
            </div>`;
      }
      return A;
    }
    _renderPrimaryStatus() {
      if (this.isOnPrimary) {
        return b2`<div class="text-green-600 dark:text-green-400">Up to date with origin/${this.primaryBranch}</div>`;
      }
      if (this.mergedIntoPrimary && this.behindPrimary === 0) {
        return b2`<div class="text-green-600 dark:text-green-400">Merged into origin/${this.primaryBranch}</div>`;
      }
      if (this.aheadOfPrimary > 0 && this.behindPrimary > 0) {
        return b2`<div class="text-muted-foreground">
                <span class="text-blue-600 dark:text-blue-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("ahead", "primary");
        }}>${this.aheadOfPrimary} ahead</span>,
                <span class="text-red-600 dark:text-red-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("behind", "primary");
        }}>${this.behindPrimary} behind</span>
                origin/${this.primaryBranch}
                ${this._renderMergePrimaryButton()}
            </div>`;
      }
      if (this.aheadOfPrimary > 0) {
        return b2`<div class="text-muted-foreground">
                <span class="text-blue-600 dark:text-blue-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("ahead", "primary");
        }}>${this.aheadOfPrimary} ahead</span>
                of origin/${this.primaryBranch}
                ${!this.prState ? this._renderAskPrButton() : A}
                ${!this.prState && this.viewerIsAdmin ? this._renderSquashPushButton() : A}
            </div>`;
      }
      if (this.behindPrimary > 0) {
        return b2`<div class="text-muted-foreground">
                <span class="text-red-600 dark:text-red-400" style="cursor:pointer;text-decoration:underline;text-decoration-style:dotted" @click=${(e8) => {
          e8.stopPropagation();
          this._fetchCommits("behind", "primary");
        }}>${this.behindPrimary} behind</span>
                origin/${this.primaryBranch}
                ${this._renderMergePrimaryButton()}
            </div>`;
      }
      return b2`<div class="text-green-600 dark:text-green-400">Up to date with origin/${this.primaryBranch}</div>`;
    }
    /** Small PR status icon + number for the pill */
    _prPillIcon() {
      if (!this.prState) return A;
      let colorClass;
      let title;
      if (this.prState === "MERGED") {
        colorClass = "text-purple-600/70 dark:text-purple-400/70";
        title = `PR #${this.prNumber} merged`;
      } else if (this.prState === "CLOSED") {
        colorClass = "text-red-600/70 dark:text-red-400/70";
        title = `PR #${this.prNumber} closed`;
      } else if (this.reviewDecision === "APPROVED") {
        colorClass = "text-green-600/70 dark:text-green-400/70";
        title = `PR #${this.prNumber} approved`;
      } else if (this.reviewDecision === "CHANGES_REQUESTED") {
        colorClass = "text-red-600/70 dark:text-red-400/70";
        title = `PR #${this.prNumber} changes requested`;
      } else if (this.reviewDecision === "REVIEW_REQUIRED") {
        colorClass = "text-amber-600/70 dark:text-amber-400/70";
        title = `PR #${this.prNumber} awaiting review`;
      } else {
        colorClass = "text-green-600/70 dark:text-green-400/70";
        title = `PR #${this.prNumber} open`;
      }
      const hasConflicts = this.prState === "OPEN" && this.prMergeable === "CONFLICTING";
      if (hasConflicts) title += " \u2014 has conflicts";
      const pulseClass = hasConflicts ? " pr-conflict-pulse" : "";
      return b2`<span class="${colorClass}${pulseClass} shrink-0" style="display:inline-flex;align-items:center;gap:1px" title=${title}><span style="font-size:10px">⦿</span>${this.prNumber != null ? b2`<span style="font-size:10px">#${this.prNumber}</span>` : A}</span>`;
    }
    /** Review decision badge for inside the PR section */
    _renderReviewBadge() {
      if (!this.reviewDecision || this.prState !== "OPEN") return A;
      const cfg = {
        APPROVED: { label: "Approved", color: "oklch(0.68 0.12 145)", bg: "oklch(0.68 0.12 145 / 0.12)" },
        CHANGES_REQUESTED: { label: "Changes Requested", color: "oklch(0.62 0.14 25)", bg: "oklch(0.62 0.14 25 / 0.12)" },
        REVIEW_REQUIRED: { label: "Awaiting Review", color: "oklch(0.65 0.12 60)", bg: "oklch(0.65 0.12 60 / 0.12)" }
      };
      const c5 = cfg[this.reviewDecision];
      if (!c5) return A;
      return b2`<span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;color:${c5.color};background:${c5.bg}">${c5.label}</span>`;
    }
    /** PR section for the expanded dropdown */
    _renderPrSection() {
      if (!this.prState) return A;
      const badgeColor = this.prState === "OPEN" ? "oklch(0.68 0.12 145)" : this.prState === "MERGED" ? "oklch(0.62 0.13 300)" : "oklch(0.62 0.14 25)";
      const badgeBg = this.prState === "OPEN" ? "oklch(0.68 0.12 145 / 0.12)" : this.prState === "MERGED" ? "oklch(0.62 0.13 300 / 0.12)" : "oklch(0.62 0.14 25 / 0.12)";
      return b2`
            <div class="border-t border-border pt-2 mt-2">
                <div class="text-muted-foreground mb-1 font-medium">Pull Request</div>
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
                    ${this.prUrl ? b2`
                        <a href=${this.prUrl} target="_blank" rel="noopener"
                           class="text-blue-600 dark:text-blue-400 hover:underline" style="font-size:12px">
                            #${this.prNumber} ${this.prTitle}
                        </a>
                    ` : b2`<span style="font-size:12px">#${this.prNumber} ${this.prTitle}</span>`}
                    <span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;color:${badgeColor};background:${badgeBg}">
                        ${this.prState}
                    </span>
                    ${this._renderReviewBadge()}
                    ${this.prState === "OPEN" && this.prMergeable === "CONFLICTING" ? b2`<span style="display:inline-block;padding:1px 6px;border-radius:9999px;font-size:10px;font-weight:600;color:oklch(0.62 0.14 25);background:oklch(0.62 0.14 25 / 0.12)">Has conflicts</span>` : A}
                </div>
                ${this.prState === "OPEN" ? b2`
                    <div style="display:flex;align-items:center;gap:6px;margin-top:6px">
                        <select
                            style="font-size:11px;padding:2px 4px;border-radius:4px;border:1px solid var(--border);background:var(--card);color:var(--foreground)"
                            .value=${this.mergeMethod}
                            @change=${(e8) => {
        this.mergeMethod = e8.target.value;
      }}
                            ?disabled=${this.merging}
                        >
                            <option value="merge">Merge</option>
                            <option value="squash">Squash</option>
                            <option value="rebase">Rebase</option>
                        </select>
                        ${this.merging ? b2`<span style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted-foreground)"><span style="display:inline-block;width:12px;height:12px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>Merging\u2026</span>` : b2`
                        <button
                            style="font-size:11px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.68 0.12 145 / 0.12);color:oklch(0.68 0.12 145);cursor:pointer;font-weight:500"
                            ?disabled=${this.prMergeable !== "MERGEABLE"}
                            @click=${() => this._handleMerge()}
                        >
                            Merge PR
                        </button>
                        ${this.viewerIsAdmin ? b2`<button
                            style="font-size:11px;padding:2px 10px;border-radius:4px;border:1px solid var(--border);background:oklch(0.62 0.14 25 / 0.12);color:oklch(0.62 0.14 25);cursor:pointer;font-weight:500"
                            @click=${() => this._handleForceMerge()}
                            title="Merge with --admin to bypass branch protection rules"
                        >
                            Force Merge
                        </button>` : A}
                        ${this.prMergeable !== "MERGEABLE" && !this.viewerIsAdmin ? b2`<span style="font-size:10px;color:var(--destructive)">${this.prMergeable === "CONFLICTING" ? "Has conflicts" : "Not mergeable"}</span>` : A}
                        `}
                    </div>
                    ${this.mergeError ? b2`<div style="font-size:11px;color:var(--destructive);margin-top:4px">${this.mergeError}</div>` : A}
                ` : A}
            </div>
        `;
    }
    _renderMergePrimaryButton() {
      return b2`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.mergingPrimary}
            @click=${(e8) => {
        e8.stopPropagation();
        this._handleMergePrimary();
      }}
            title="Rebase this branch on top of origin/master"
        >${this.mergingPrimary ? "Rebasing\u2026" : "Rebase on master"}</button>${this.mergePrimaryError ? b2`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.mergePrimaryError}</span>` : A}`;
    }
    _handleMergePrimary() {
      this.mergingPrimary = true;
      this.mergePrimaryError = "";
      this.dispatchEvent(new CustomEvent("git-merge-primary", {
        bubbles: true,
        composed: true
      }));
    }
    setMergePrimaryResult(error) {
      this.mergingPrimary = false;
      this.mergePrimaryError = error || "";
    }
    _renderAskCommitButton() {
      return b2`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500"
            @click=${(e8) => {
        e8.stopPropagation();
        this.dispatchEvent(new CustomEvent("ask-agent-commit", { bubbles: true, composed: true }));
      }}
        >Ask agent to commit</button>`;
    }
    _renderAskPrButton() {
      return b2`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            @click=${(e8) => {
        e8.stopPropagation();
        this.dispatchEvent(new CustomEvent("ask-agent-pr", { bubbles: true, composed: true }));
      }}
        >Ask agent to raise PR</button>`;
    }
    _renderSquashPushButton() {
      return b2`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 145 / 0.12);color:oklch(0.55 0.12 145);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.squashPushing}
            @click=${(e8) => {
        e8.stopPropagation();
        this._handleSquashPush();
      }}
            title="Squash all branch commits into one and push directly to master"
        >${this.squashPushing ? "Pushing\u2026" : "Squash push"}</button>${this.squashPushError ? b2`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.squashPushError}</span>` : A}`;
    }
    _handleSquashPush() {
      this.squashPushing = true;
      this.squashPushError = "";
      this.dispatchEvent(new CustomEvent("git-squash-push", {
        bubbles: true,
        composed: true
      }));
    }
    setSquashPushResult(error) {
      this.squashPushing = false;
      this.squashPushError = error || "";
    }
    _renderPullButton() {
      return b2`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 250 / 0.12);color:oklch(0.55 0.12 250);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.pulling}
            @click=${() => this._handlePull()}
        >${this.pulling ? "Pulling\u2026" : "Pull"}</button>${this.pullError ? b2`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.pullError}</span>` : A}`;
    }
    _handlePull() {
      this.pulling = true;
      this.pullError = "";
      this.dispatchEvent(new CustomEvent("git-pull", {
        bubbles: true,
        composed: true
      }));
    }
    /** Called by the parent after pull completes or fails */
    setPullResult(error) {
      this.pulling = false;
      this.pullError = error || "";
    }
    _renderPushButton() {
      return b2`<button
            style="font-size:11px;padding:1px 8px;border-radius:4px;border:1px solid var(--border);background:oklch(0.55 0.12 145 / 0.12);color:oklch(0.55 0.12 145);cursor:pointer;font-weight:500;margin-left:4px"
            ?disabled=${this.pushing}
            @click=${() => this._handlePush()}
        >${this.pushing ? "Pushing\u2026" : "Push"}</button>${this.pushError ? b2`<span style="font-size:10px;color:var(--destructive);margin-left:4px">${this.pushError}</span>` : A}`;
    }
    _handlePush() {
      this.pushing = true;
      this.pushError = "";
      this.dispatchEvent(new CustomEvent("git-push", {
        bubbles: true,
        composed: true
      }));
    }
    /** Called by the parent after push completes or fails */
    setPushResult(error) {
      this.pushing = false;
      this.pushError = error || "";
      this.dispatchEvent(new CustomEvent("git-fetch", {
        bubbles: true,
        composed: true
      }));
    }
    _handleMerge() {
      this.merging = true;
      this.mergeError = "";
      this.dispatchEvent(new CustomEvent("pr-merge", {
        bubbles: true,
        composed: true,
        detail: { method: this.mergeMethod, ...this.headRefName ? { branch: this.headRefName } : {} }
      }));
    }
    _handleForceMerge() {
      this.merging = true;
      this.mergeError = "";
      this.dispatchEvent(new CustomEvent("pr-merge", {
        bubbles: true,
        composed: true,
        detail: { method: this.mergeMethod, admin: true, ...this.headRefName ? { branch: this.headRefName } : {} }
      }));
    }
    /** Called by the parent after merge completes or fails */
    setMergeResult(error) {
      this.merging = false;
      this.mergeError = error || "";
      this.dispatchEvent(new CustomEvent("git-fetch", {
        bubbles: true,
        composed: true
      }));
    }
    async _openDiffModal(file) {
      this._modalFile = file;
      this._loadingDiff = file;
      this._diffContent = null;
      this._diffError = null;
      this._showModal();
      const base = this.sessionId ? `/api/sessions/${this.sessionId}/git-diff` : `/api/goals/${this.goalId}/git-diff`;
      const url = `${base}?file=${encodeURIComponent(file)}`;
      try {
        const headers = {};
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
        const resp = await fetch(url, { headers });
        if (this._modalFile !== file) return;
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          this._diffError = body.error || `HTTP ${resp.status}`;
        } else {
          const body = await resp.json();
          this._diffContent = body.diff;
        }
      } catch (err) {
        if (this._modalFile !== file) return;
        this._diffError = String(err);
      }
      this._loadingDiff = null;
      this._renderModal();
    }
    _showModal() {
      this._removeModal();
      this._modalEl = document.createElement("div");
      this._modalEl.id = "git-diff-modal";
      document.body.appendChild(this._modalEl);
      document.addEventListener("keydown", this._onEscapeKey);
      this._renderModal();
    }
    _renderModal() {
      if (!this._modalEl || !this._modalFile) return;
      let body;
      if (this._loadingDiff === this._modalFile) {
        body = b2`<div class="flex items-center gap-2 text-muted-foreground p-8">
                <span style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>
                Loading diff\u2026
            </div>`;
      } else if (this._diffError) {
        body = b2`<div class="p-8" style="color:var(--destructive)">${this._diffError}</div>`;
      } else if (this._diffContent) {
        body = b2`<diff-block .content=${this._diffContent}></diff-block>`;
      } else {
        body = b2`<div class="p-8 text-muted-foreground">No diff available</div>`;
      }
      D(b2`
            <div style="position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px"
                 @click=${(e8) => {
        if (e8.target === e8.currentTarget) this._closeModal();
      }}>
                <div style="position:absolute;inset:0;background:rgba(0,0,0,0.5)" @click=${() => this._closeModal()}></div>
                <div style="position:relative;width:100%;max-width:calc(100vw - 48px);height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:8px;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25)">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
                        <span class="font-mono text-sm text-foreground truncate" title=${this._modalFile}>${this._modalFile}</span>
                        <button
                            style="background:none;border:none;color:var(--muted-foreground);cursor:pointer;padding:4px 8px;font-size:18px;line-height:1;border-radius:4px"
                            class="hover:text-foreground hover:bg-muted/50"
                            @click=${() => this._closeModal()}
                            title="Close"
                        >&times;</button>
                    </div>
                    <div style="flex:1;overflow:auto">${body}</div>
                </div>
            </div>
        `, this._modalEl);
    }
    _closeModal() {
      this._modalFile = null;
      this._diffContent = null;
      this._diffError = null;
      this._removeModal();
    }
    _removeModal() {
      document.removeEventListener("keydown", this._onEscapeKey);
      if (this._modalEl) {
        this._modalEl.remove();
        this._modalEl = null;
      }
    }
    async _fetchCommits(direction = "ahead", vs) {
      this._commitsLoading = true;
      this._commits = [];
      this._commitsError = null;
      this._commitsDirection = direction;
      this._commitsVs = vs;
      this._showCommitsModal();
      const basePath = this.sessionId ? `/api/sessions/${this.sessionId}/commits` : `/api/goals/${this.goalId}/commits`;
      const params = new URLSearchParams();
      if (direction === "behind") params.set("direction", "behind");
      if (vs) params.set("vs", vs);
      const base = params.toString() ? `${basePath}?${params}` : basePath;
      try {
        const headers = {};
        if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
        const resp = await fetch(base, { headers });
        if (!resp.ok) {
          const body = await resp.json().catch(() => ({}));
          this._commitsError = body.error || `HTTP ${resp.status}`;
        } else {
          const body = await resp.json();
          this._commits = body.commits || [];
        }
      } catch (err) {
        this._commitsError = String(err);
      }
      this._commitsLoading = false;
      this._renderCommitsModal();
    }
    _showCommitsModal() {
      this._removeCommitsModal();
      this._commitsModalEl = document.createElement("div");
      this._commitsModalEl.id = "git-commits-modal";
      document.body.appendChild(this._commitsModalEl);
      document.addEventListener("keydown", this._onEscapeKey);
      this._renderCommitsModal();
    }
    _renderCommitsModal() {
      if (!this._commitsModalEl) return;
      let body;
      if (this._commitsLoading) {
        body = b2`<div class="flex items-center gap-2 text-muted-foreground p-8">
                <span style="display:inline-block;width:14px;height:14px;border:2px solid var(--border);border-top-color:var(--foreground);border-radius:50%;animation:git-spin 0.6s linear infinite"></span>
                Loading commits\u2026
            </div>`;
      } else if (this._commitsError) {
        body = b2`<div class="p-8" style="color:var(--destructive)">${this._commitsError}</div>`;
      } else if (this._commits.length === 0) {
        body = b2`<div class="p-8 text-muted-foreground">${this._commitsDirection === "behind" ? "No incoming commits" : "No unpushed commits"}</div>`;
      } else {
        body = b2`<div class="flex flex-col">
                ${this._commits.map((c5) => b2`
                    <div class="flex items-start gap-3 px-4 py-3 border-b border-border last:border-b-0 hover:bg-muted/30" style="min-width:0">
                        <span class="font-mono text-[11px] text-muted-foreground shrink-0 pt-0.5" title=${c5.sha}>${c5.shortSha}</span>
                        <div class="flex-1 min-w-0">
                            <div class="text-sm text-foreground break-words">${c5.message}</div>
                            <div class="flex items-center gap-3 mt-1 text-[11px] text-muted-foreground">
                                <span>${c5.author}</span>
                                <span>${this._relativeTime(c5.timestamp)}</span>
                                ${c5.filesChanged > 0 ? b2`<span class="flex items-center gap-1.5">
                                    <span>${c5.filesChanged} file${c5.filesChanged !== 1 ? "s" : ""}</span>
                                    ${c5.insertions > 0 ? b2`<span class="text-green-600 dark:text-green-400">+${c5.insertions}</span>` : A}
                                    ${c5.deletions > 0 ? b2`<span class="text-red-600 dark:text-red-400">-${c5.deletions}</span>` : A}
                                </span>` : A}
                            </div>
                        </div>
                    </div>
                `)}
            </div>`;
      }
      D(b2`
            <div style="position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;padding:24px"
                 @click=${(e8) => {
        if (e8.target === e8.currentTarget) this._closeCommitsModal();
      }}>
                <div style="position:absolute;inset:0;background:rgba(0,0,0,0.5)" @click=${() => this._closeCommitsModal()}></div>
                <div style="position:relative;width:100%;max-width:600px;max-height:calc(100vh - 48px);display:flex;flex-direction:column;background:var(--card);color:var(--foreground);border:1px solid var(--border);border-radius:8px;overflow:hidden;box-shadow:0 25px 50px -12px rgba(0,0,0,0.25)">
                    <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--border);flex-shrink:0">
                        <span class="text-sm font-medium text-foreground">${this._commits.length} ${this._commitsVs === "primary" ? this._commitsDirection === "behind" ? "Behind Master" : "Ahead of Master" : this._commitsDirection === "behind" ? "Incoming" : "Unpushed"} Commit${this._commits.length !== 1 ? "s" : ""}</span>
                        <button
                            style="background:none;border:none;color:var(--muted-foreground);cursor:pointer;padding:4px 8px;font-size:18px;line-height:1;border-radius:4px"
                            class="hover:text-foreground hover:bg-muted/50"
                            @click=${() => this._closeCommitsModal()}
                            title="Close"
                        >&times;</button>
                    </div>
                    <div style="flex:1;overflow:auto">${body}</div>
                </div>
            </div>
        `, this._commitsModalEl);
    }
    _closeCommitsModal() {
      this._commits = [];
      this._commitsError = null;
      this._commitsLoading = false;
      this._removeCommitsModal();
    }
    _removeCommitsModal() {
      if (this._commitsModalEl) {
        document.removeEventListener("keydown", this._onEscapeKey);
        this._commitsModalEl.remove();
        this._commitsModalEl = null;
      }
    }
    _relativeTime(timestamp) {
      const now = Date.now();
      const then = new Date(timestamp).getTime();
      const seconds = Math.floor((now - then) / 1e3);
      if (seconds < 60) return "just now";
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return `${minutes}m ago`;
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 30) return `${days}d ago`;
      return new Date(timestamp).toLocaleDateString();
    }
    _renderDropdownContent() {
      return b2`
            <div class="flex items-center gap-1.5 mb-2 text-foreground font-medium text-sm">
                <span>⎇</span>
                <span class="break-all">${this.branch}</span>
            </div>

            <div class="flex flex-col gap-1 mb-2">
                ${this._renderPrimaryStatus()}
                ${this._renderRemoteStatus()}
            </div>

            ${this._renderPrSection()}

            ${this.statusFiles.length > 0 ? b2`
                      <div class="border-t border-border pt-2 mt-2">
                          <div class="text-muted-foreground mb-1 flex items-center gap-2">
                              <span class="text-amber-600 dark:text-amber-400">${this.statusFiles.length} uncommitted change${this.statusFiles.length !== 1 ? "s" : ""}</span>
                              ${this._renderAskCommitButton()}
                          </div>
                          <div class="flex flex-col gap-0.5 overflow-y-auto" style="max-height:200px">
                              ${this.statusFiles.map(
        (f4) => b2`
                                      <div class="flex items-center gap-2 py-0.5 min-w-0 rounded px-1 -mx-1 ${this.sessionId || this.goalId ? "cursor-pointer hover:bg-muted/50" : ""}"
                                           @click=${() => this.sessionId || this.goalId ? this._openDiffModal(f4.file) : void 0}>
                                          <span
                                              class="${this._statusColor(f4.status)} font-mono w-[70px] shrink-0 text-right"
                                              title=${this._statusLabel(f4.status)}
                                          >
                                              ${this._statusLabel(f4.status)}
                                          </span>
                                          <span class="text-foreground truncate" title=${f4.file}>
                                              ${f4.file}
                                          </span>
                                      </div>
                                  `
      )}
                          </div>
                      </div>
                  ` : b2`
                      <div class="text-green-600 dark:text-green-400 border-t border-border pt-2 mt-2">
                          Working tree clean
                      </div>
                  `}
        `;
    }
    render() {
      this._ensureWidgetStyles();
      if (this.loading && !this.branch) {
        return b2`
                <button
                    class="git-status-pill skeleton inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground text-[11px] leading-tight"
                    style="max-width:100%; height:var(--pill-h, auto); min-width:110px"
                    aria-busy="true"
                    disabled
                    data-state="skeleton"
                >
                    <span class="git-skeleton-shimmer" aria-hidden="true"></span>
                    <span class="shrink-0 relative z-10">⎇</span>
                    <span class="truncate relative z-10">Checking git\u2026</span>
                </button>
            `;
      }
      if (!this.branch) return A;
      const segments = this._pillSegments();
      const showClean = this.clean && segments.length === 0 && !this.prState && (this.isOnPrimary || this.mergedIntoPrimary) && (this.isOnPrimary || this.aheadOfPrimary === 0);
      const stateAttr = this.loading ? "refreshing" : this.partial ? "partial" : "ready";
      const refreshDot = this.loading ? b2`<span class="git-refresh-dot" aria-label="Refreshing" title="Refreshing git status\u2026"></span>` : this.partial ? b2`<span class="git-partial-dot" aria-label="Partial" title="Status scan timed out \u2014 showing partial data."></span>` : A;
      return b2`
            <button
                class="git-status-pill inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-card border border-border text-muted-foreground hover:text-foreground transition-colors cursor-pointer text-[11px] leading-tight ${this.loading ? "loading" : ""} ${this.partial ? "partial" : ""}"
                style="max-width:100%; height:var(--pill-h, auto)"
                data-state=${stateAttr}
                @click=${this._toggle}
            >
                <span class="shrink-0 relative" style="display:inline-block">⎇${refreshDot}</span>
                <span class="truncate">${this.branch}</span>
                ${showClean ? b2`<span class="text-green-600 dark:text-green-400 font-medium shrink-0">clean</span>` : A}
                ${segments}
                ${this._prPillIcon()}
            </button>
        `;
    }
    _ensureWidgetStyles() {
      if (typeof document === "undefined") return;
      if (document.getElementById("git-status-widget-styles")) return;
      const style = document.createElement("style");
      style.id = "git-status-widget-styles";
      style.textContent = `
            @keyframes git-status-shimmer {
                0%   { background-position: -120% 0; }
                100% { background-position: 220% 0; }
            }
            @keyframes git-status-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50%      { opacity: 0.4; transform: scale(0.8); }
            }
            .git-status-pill.skeleton {
                position: relative;
                overflow: hidden;
                cursor: default;
                opacity: 0.85;
            }
            .git-skeleton-shimmer {
                position: absolute;
                inset: 0;
                background: linear-gradient(
                    90deg,
                    transparent 0%,
                    rgba(255, 255, 255, 0.08) 40%,
                    rgba(255, 255, 255, 0.18) 50%,
                    rgba(255, 255, 255, 0.08) 60%,
                    transparent 100%
                );
                background-size: 200% 100%;
                animation: git-status-shimmer 1.2s linear infinite;
                pointer-events: none;
                z-index: 0;
            }
            .git-refresh-dot {
                position: absolute;
                top: -1px;
                right: -3px;
                width: 6px;
                height: 6px;
                border-radius: 9999px;
                background: var(--primary, #60a5fa);
                animation: git-status-pulse 1s ease-in-out infinite;
                pointer-events: none;
            }
            .git-partial-dot {
                position: absolute;
                top: -1px;
                right: -3px;
                width: 6px;
                height: 6px;
                border-radius: 9999px;
                background: #f59e0b;
                box-shadow: 0 0 0 1px rgba(245, 158, 11, 0.35);
                pointer-events: none;
            }
        `;
      document.head.appendChild(style);
    }
    updated(changed) {
      super.updated(changed);
      if (changed.has("expanded")) {
        if (this.expanded) {
          if (!document.getElementById("git-dropdown-anim-styles")) {
            const styleEl = document.createElement("style");
            styleEl.id = "git-dropdown-anim-styles";
            styleEl.textContent = `
                        @keyframes git-dropdown-in {
                            0%   { opacity: 0; transform: translateY(8px) scale(0.92); filter: blur(3px); }
                            70%  { opacity: 1; transform: translateY(-1px) scale(1.005); filter: blur(0); }
                            100% { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
                        }
                        @keyframes git-dropdown-out {
                            0%   { opacity: 1; transform: translateY(0) scale(1); filter: blur(0); }
                            100% { opacity: 0; transform: translateY(6px) scale(0.95); filter: blur(2px); }
                        }
                        #git-status-dropdown {
                            animation: git-dropdown-in 300ms cubic-bezier(0.175, 0.885, 0.32, 1.275);
                        }
                        #git-status-dropdown.git-dropdown-closing {
                            animation: git-dropdown-out 200ms cubic-bezier(0.4, 0, 1, 1) forwards;
                        }
                    `;
            document.head.appendChild(styleEl);
          }
          this._dropdownEl = document.createElement("div");
          this._dropdownEl.id = "git-status-dropdown";
          this._dropdownEl.className = "fixed z-[9999] bg-card border border-border rounded-lg shadow-lg p-3 text-xs";
          this._dropdownEl.style.maxWidth = "min(420px, calc(100vw - 1rem))";
          document.body.appendChild(this._dropdownEl);
          D(this._renderDropdownContent(), this._dropdownEl);
          this._positionDropdown();
        } else {
          this._removeDropdown();
        }
      } else if (this.expanded && this._dropdownEl) {
        D(this._renderDropdownContent(), this._dropdownEl);
      }
    }
    _positionDropdown() {
      const btn = this.querySelector("button");
      const dropdown = this._dropdownEl;
      if (!btn || !dropdown) return;
      const rect = btn.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      const spaceAbove = rect.top;
      const vw = window.innerWidth;
      const pad = 8;
      let rightVal = vw - rect.right;
      const dropdownWidth = dropdown.offsetWidth || 0;
      if (dropdownWidth > 0) {
        const leftEdge = vw - rightVal - dropdownWidth;
        if (leftEdge < pad) {
          rightVal = Math.max(pad, vw - dropdownWidth - pad);
        }
      }
      dropdown.style.right = `${rightVal}px`;
      dropdown.style.left = "";
      if (spaceAbove > spaceBelow) {
        dropdown.style.bottom = `${window.innerHeight - rect.top + 4}px`;
        dropdown.style.top = "";
      } else {
        dropdown.style.top = `${rect.bottom + 4}px`;
        dropdown.style.bottom = "";
      }
    }
  };
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "branch", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "primaryBranch", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "isOnPrimary", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "summary", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "clean", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "hasUpstream", 2);
  __decorateClass([
    n4({ type: Number })
  ], GitStatusWidget.prototype, "ahead", 2);
  __decorateClass([
    n4({ type: Number })
  ], GitStatusWidget.prototype, "behind", 2);
  __decorateClass([
    n4({ type: Number })
  ], GitStatusWidget.prototype, "aheadOfPrimary", 2);
  __decorateClass([
    n4({ type: Number })
  ], GitStatusWidget.prototype, "behindPrimary", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "mergedIntoPrimary", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "unpushed", 2);
  __decorateClass([
    n4({ type: Array })
  ], GitStatusWidget.prototype, "statusFiles", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "loading", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "partial", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "sessionId", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "goalId", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "token", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "prState", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "prUrl", 2);
  __decorateClass([
    n4({ type: Number })
  ], GitStatusWidget.prototype, "prNumber", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "prTitle", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "prMergeable", 2);
  __decorateClass([
    n4({ type: Boolean })
  ], GitStatusWidget.prototype, "viewerIsAdmin", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "reviewDecision", 2);
  __decorateClass([
    n4()
  ], GitStatusWidget.prototype, "headRefName", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_modalFile", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_loadingDiff", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_diffContent", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_diffError", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_commitsLoading", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_commits", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_commitsError", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_commitsDirection", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_commitsVs", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "expanded", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "merging", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "mergeError", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "mergeMethod", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "pulling", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "pullError", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "pushing", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "pushError", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "mergingPrimary", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "mergePrimaryError", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "_closing", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "squashPushing", 2);
  __decorateClass([
    r5()
  ], GitStatusWidget.prototype, "squashPushError", 2);
  GitStatusWidget = __decorateClass([
    t3("git-status-widget")
  ], GitStatusWidget);

  // tests/fixtures/git-status-widget-states-entry.ts
  window.__ready = true;
})();
/*! Bundled license information:

@lit/reactive-element/css-tag.js:
  (**
   * @license
   * Copyright 2019 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/reactive-element.js:
lit-html/lit-html.js:
lit-element/lit-element.js:
@lit/reactive-element/decorators/custom-element.js:
@lit/reactive-element/decorators/property.js:
@lit/reactive-element/decorators/state.js:
@lit/reactive-element/decorators/event-options.js:
@lit/reactive-element/decorators/base.js:
@lit/reactive-element/decorators/query.js:
@lit/reactive-element/decorators/query-all.js:
@lit/reactive-element/decorators/query-async.js:
@lit/reactive-element/decorators/query-assigned-nodes.js:
lit-html/directive.js:
lit-html/async-directive.js:
lit-html/directives/unsafe-html.js:
  (**
   * @license
   * Copyright 2017 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/is-server.js:
  (**
   * @license
   * Copyright 2022 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

@lit/reactive-element/decorators/query-assigned-elements.js:
  (**
   * @license
   * Copyright 2021 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lit-html/directive-helpers.js:
lit-html/directives/ref.js:
  (**
   * @license
   * Copyright 2020 Google LLC
   * SPDX-License-Identifier: BSD-3-Clause
   *)

lucide/dist/esm/defaultAttributes.js:
lucide/dist/esm/createElement.js:
lucide/dist/esm/icons/check.js:
lucide/dist/esm/icons/columns-2.js:
lucide/dist/esm/icons/copy.js:
lucide/dist/esm/icons/rows-2.js:
lucide/dist/esm/lucide.js:
  (**
   * @license lucide v0.544.0 - ISC
   *
   * This source code is licensed under the ISC license.
   * See the LICENSE file in the root directory of this source tree.
   *)
*/
