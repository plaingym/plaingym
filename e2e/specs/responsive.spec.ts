// SPDX-License-Identifier: AGPL-3.0-only
import { test, expect, type Page } from '@playwright/test';
import { horizontalOverflow } from '../responsive.js';

// These pages are served by the test itself: the layout check needs no install.
test.use({ viewport: { width: 360, height: 740 }, trace: 'off', screenshot: 'off' });

const wide = 'width: 600px; height: 20px';
async function show(page: Page, html: string, rootStyle = '') {
  await page.setContent(`<!doctype html><html style="${rootStyle}"><body style="margin:0">${html}</body></html>`);
}

test('reports an element that makes the page scroll sideways, and names it', async ({ page }) => {
  await show(page, `<main><p id="wide" style="${wide}">Too wide</p></main>`);
  expect(await horizontalOverflow(page)).toMatch(/^p#wide "Too wide" ends at 600px in a 360px viewport$/);
});

test('accepts a wide element in a container that scrolls or clips it', async ({ page }) => {
  for (const clip of ['overflow-x: auto', 'overflow-x: hidden']) {
    await show(page, `<div style="${clip}"><p style="${wide}">Inside</p></div>`);
    expect(await horizontalOverflow(page), clip).toBeUndefined();
  }
});

// A static element with one of these forms the containing block of its absolutely positioned descendants, so its clipping
// applies to them. Without the property the same element clips nothing of an absolute child.
for (const property of ['transform: translateX(0)', 'translate: 0 0', 'rotate: 0deg', 'scale: 1', 'filter: blur(0)', 'backdrop-filter: blur(0)',
  'perspective: 100px', 'contain: layout', 'contain: paint', 'contain: strict', 'will-change: transform', 'will-change: filter',
  'content-visibility: auto']) {
  test(`${property} on a static ancestor is the containing block of an absolute element`, async ({ page }) => {
    const child = `<span style="position: absolute; left: 0; ${wide}">Out</span>`;
    await show(page, `<div style="overflow: hidden; ${property}">${child}</div>`);
    expect(await horizontalOverflow(page), 'clipped by the block it is positioned against').toBeUndefined();
    await show(page, `<div style="overflow: hidden">${child}</div>`);
    expect(await horizontalOverflow(page), 'the same container without the property').toMatch(/^span "Out" ends at 600px/);
  });
}

// A size container applies size and style containment but not layout containment, so it is no containing block.
for (const type of ['inline-size', 'size']) {
  test(`container-type: ${type} is not the containing block of an absolute element`, async ({ page }) => {
    await show(page, `<div style="overflow: hidden; container-type: ${type}"><span style="position: absolute; left: 0; ${wide}">Out</span></div>`);
    expect(await horizontalOverflow(page)).toMatch(/^span "Out" ends at 600px/);
  });
}

// Paint containment clips its contents to the padding box with no overflow setting, so a wide child inside doesn't widen the
// page. Another element does here, and is the one named, though the clipped child is wider.
for (const [property, clips] of [['contain: paint', true], ['contain: strict', true], ['contain: content', true], ['content-visibility: auto', true],
  ['contain: layout', false], ['container-type: inline-size', false]] as const) {
  test(`${property} ${clips ? 'clips' : 'does not clip'} a wide child`, async ({ page }) => {
    await show(page, `<div style="${property}; height: 40px"><p style="width: 700px; height: 20px">Inside</p></div><p style="${wide}">Too wide</p>`);
    expect(await horizontalOverflow(page)).toMatch(clips ? /^p "Too wide" ends at 600px/ : /^p "Inside" ends at 700px/);
  });
}

test('a fixed element is clipped only by an ancestor that forms its containing block', async ({ page }) => {
  const child = `<span style="position: fixed; top: 0; left: 0; ${wide}">Pinned</span>`;
  await show(page, `<div style="overflow: hidden; transform: translateX(0)">${child}</div>`);
  expect(await horizontalOverflow(page), 'inside a transformed ancestor').toBeUndefined();
  // A viewport-fixed element never widens the page.
  await show(page, `<div style="overflow: hidden">${child}</div><p style="${wide}">Too wide</p>`);
  expect(await horizontalOverflow(page), 'the wide paragraph, not the fixed element').toMatch(/^p "Too wide"/);
});

test('an absolute element is still clipped by a positioned clipping ancestor', async ({ page }) => {
  await show(page, `<div style="position: relative; overflow: hidden"><span style="position: absolute; left: 0; ${wide}">In</span></div>`);
  expect(await horizontalOverflow(page)).toBeUndefined();
});

test('a clipped or hidden root cannot scroll sideways, but a scrolling one can', async ({ page }) => {
  const content = `<p style="${wide}">Too wide</p>`;
  for (const overflow of ['hidden', 'clip']) {
    await show(page, content, `overflow-x: ${overflow}`);
    expect(await horizontalOverflow(page), `html overflow-x: ${overflow}`).toBeUndefined();
  }
  // With a visible root, the body's overflow applies to the viewport.
  await page.setContent(`<!doctype html><html><body style="margin:0; overflow-x: hidden">${content}</body></html>`);
  expect(await horizontalOverflow(page), 'body overflow-x: hidden').toBeUndefined();
  for (const overflow of ['auto', 'scroll']) {
    await show(page, content, `overflow-x: ${overflow}`);
    expect(await horizontalOverflow(page), `html overflow-x: ${overflow}`).toMatch(/^p "Too wide"/);
  }
});
