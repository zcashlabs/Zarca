// Prepended to automation scripts: minimal DOM driving helpers.
const $$ = (sel) => [...document.querySelectorAll(sel)];
const visible = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
function clickText(text, sel = "button,[role=option],[role=tab],a,label") {
	const el = $$(sel).filter(visible).find((e) => e.innerText.trim().replace(/\s+/g, " ").includes(text));
	if (!el) throw new Error("No element with text: " + text);
	el.click();
	return true;
}
function setValue(el, value) {
	const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : el.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
	el.dispatchEvent(new Event(el.tagName === "SELECT" ? "change" : "input", { bubbles: true }));
}
function fieldByLabel(label) {
	const lab = $$("label").filter(visible).find((l) => l.innerText.trim().startsWith(label));
	if (!lab) throw new Error("No label: " + label);
	return lab.parentElement.querySelector("input,textarea,select");
}
function fill(label, value) { setValue(fieldByLabel(label), value); return true; }
function fillPlaceholder(ph, value) {
	const el = $$("input,textarea").filter(visible).find((e) => (e.placeholder || "").includes(ph));
	if (!el) throw new Error("No placeholder: " + ph);
	setValue(el, value);
	return true;
}
const text = () => document.body.innerText;
