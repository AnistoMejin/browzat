'use strict';
const { TAB } = require('../tool-modules');

const TARGET = { ref: { type: 'string' }, selector: { type: 'string' } };
const tools = [
  { name: 'verify', description: 'Assert that an element, text, list of texts or field value is visible on the page. A failed assertion is a tool error with the observed value.', inputSchema: { type: 'object', properties: Object.assign({ tab: TAB, kind: { type: 'string', enum: ['element', 'text', 'list', 'value'] }, text: { type: 'string' }, texts: { type: 'array', items: { type: 'string' } }, value: {}, exact: { type: 'boolean' } }, TARGET), required: ['tab', 'kind'] } },
  { name: 'inspect', description: 'Inspect one element or the page: text, HTML, attributes, box, generated locator, computed styles, or frames.', inputSchema: { type: 'object', properties: Object.assign({ tab: TAB, what: { type: 'string', enum: ['text', 'html', 'attributes', 'box', 'locator', 'styles', 'frames'] }, max_chars: { type: 'number' } }, TARGET), required: ['tab', 'what'] } },
  { name: 'fill_form', description: 'Fill several form fields in one call. Each field names a ref or CSS selector and a value. Arrays select multiple options.', inputSchema: { type: 'object', properties: { tab: TAB, fields: { type: 'array', items: { type: 'object', properties: Object.assign({ value: {} }, TARGET), required: ['value'] } }, submit: { type: 'boolean' } }, required: ['tab', 'fields'] } },
  { name: 'scroll', description: 'Scroll the page or an element by pixels, to an edge, or bring a target into view.', inputSchema: { type: 'object', properties: Object.assign({ tab: TAB, x: { type: 'number' }, y: { type: 'number' }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] }, amount: { type: 'number' } }, TARGET), required: ['tab'] } },
  { name: 'highlight', description: 'Show or hide a temporary outline and optional label around an element.', inputSchema: { type: 'object', properties: Object.assign({ tab: TAB, action: { type: 'string', enum: ['show', 'hide'] }, color: { type: 'string' }, label: { type: 'string' } }, TARGET), required: ['tab'] } },
  { name: 'audit', description: 'Run fast accessibility, usability and page-quality checks without sending page data to an external service.', inputSchema: { type: 'object', properties: { tab: TAB }, required: ['tab'] } },
  { name: 'logpoints', description: 'Chrome and Edge: add, remove, list or clear debugger logpoints by script URL, line and expression.', inputSchema: { type: 'object', properties: { tab: TAB, action: { type: 'string', enum: ['add', 'remove', 'list', 'clear'] }, url: { type: 'string' }, line: { type: 'number' }, expression: { type: 'string' }, id: { type: 'string' } }, required: ['tab'] } },
];

async function run(name, a, h) {
  const { result: r } = await h.send(name, a);
  if (name === 'verify') {
    if (!r.ok) throw new Error(r.message);
    return h.text('verified: ' + r.message);
  }
  if (name === 'fill_form') return h.text(`filled ${r.count} field(s)${r.submitted ? ' and submitted the form' : ''}`);
  if (name === 'scroll') return h.text(`scrolled to ${Math.round(r.x)}, ${Math.round(r.y)}${r.target ? ' (' + r.target + ')' : ''}`);
  if (name === 'highlight') return h.text(r.hidden ? 'highlight hidden' : 'highlighted ' + r.target);
  if (name === 'audit') return h.text(`${r.passed} passed, ${r.issues.length} issue(s)\n` + (r.issues.length ? r.issues.map((x) => `- ${x}`).join('\n') : 'no issues found'));
  if (name === 'logpoints') return h.text(r.lines.length ? r.lines.join('\n') : 'no logpoints in this tab');
  let value = typeof r.value === 'string' ? r.value : JSON.stringify(r.value, null, 2);
  const max = Math.min(Math.max(Number(a.max_chars) || 20000, 200), 200000);
  if (value.length > max) value = value.slice(0, max) + `\n… cut at ${max} characters`;
  return h.text(value);
}

module.exports = { tools, run };
