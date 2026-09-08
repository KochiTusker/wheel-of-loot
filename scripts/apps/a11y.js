/**
 * Giving the interface's icon-only controls a name.
 *
 * The module leans hard on icon buttons — a wedge row alone carries a jackpot
 * star, an edit pencil, a reroll die and a remove cross, and a wheel of sixty
 * wedges multiplies that by sixty. They all have `data-tooltip`, which is what
 * a sighted GM needs, and none of them had an accessible name, which is what
 * everybody else needs. Measured on one real wheel: 809 buttons announcing
 * themselves as "button".
 *
 * `data-tooltip` is not an accessible name. It is a Foundry convention read by
 * Foundry's own tooltip manager and nothing else — no assistive technology
 * knows to look at it.
 *
 * So this copies it across. Deliberately a sweep over rendered output rather
 * than an attribute added to each template: there are dozens of button
 * templates across four applications, a hand pass would miss some, and the next
 * button somebody adds would arrive unnamed. Rendering is the one place that
 * catches all of them, now and later.
 */

/**
 * Give every icon-only button in a subtree an accessible name.
 *
 * A button with visible text already has a name and is left alone; so is one
 * that has been given an `aria-label` deliberately, since a considered name
 * beats a tooltip written for hover.
 *
 * @param {HTMLElement|DocumentFragment} root
 * @returns {number} How many were named, which is what a test can assert on.
 */
export function nameIconButtons(root) {
  if (!root?.querySelectorAll) return 0;
  let named = 0;
  for (const button of root.querySelectorAll("button")) {
    if (button.getAttribute("aria-label")) continue;
    // Visible text is already the accessible name. `textContent` includes text
    // inside a <span>, which is how most of the labelled buttons are built.
    if (button.textContent.trim()) continue;
    const tip = button.dataset.tooltip;
    if (!tip) continue;
    button.setAttribute("aria-label", tip);
    named++;
  }
  return named;
}
