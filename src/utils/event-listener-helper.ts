export function addEventListener(
  el: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | AddEventListenerOptions,
) {
  removeEventListener(el, type, listener, options);
  el.addEventListener(type, listener, options);
}

export function removeEventListener(
  el: EventTarget,
  type: string,
  listener: EventListenerOrEventListenerObject,
  options?: boolean | EventListenerOptions,
) {
  el.removeEventListener(type, listener, options);
}
