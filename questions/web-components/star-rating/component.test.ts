import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import './component';

describe('star-rating', () => {
  let el: HTMLElement & { value: number };

  beforeEach(() => {
    el = document.createElement('star-rating') as HTMLElement & { value: number };
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  it('renders 5 star elements', () => {
    const stars = el.shadowRoot?.querySelectorAll('[data-star]') ?? [];
    expect(stars.length).toBe(5);
  });

  it('default value is 0', () => {
    expect(el.value).toBe(0);
  });

  it('setting value attribute updates display', () => {
    el.setAttribute('value', '3');
    expect(el.value).toBe(3);
  });

  it('clicking a star updates value', () => {
    const stars = el.shadowRoot?.querySelectorAll('[data-star]') ?? [];
    (stars[2] as HTMLElement).click();
    expect(el.value).toBe(3);
  });

  it('dispatches change event on click', () => {
    let receivedValue: number | undefined;
    const handler = (e: Event) => {
      receivedValue = (e as CustomEvent).detail?.value;
    };
    el.addEventListener('change', handler);

    const stars = el.shadowRoot?.querySelectorAll('[data-star]') ?? [];
    (stars[3] as HTMLElement).click();

    expect(receivedValue).toBe(4);
    el.removeEventListener('change', handler);
  });

  it('value property reflects attribute', () => {
    el.setAttribute('value', '2');
    expect(el.value).toBe(2);
  });

  it('setting value property updates attribute', () => {
    el.value = 5;
    expect(el.getAttribute('value')).toBe('5');
  });

  it('clamps value to 0-5', () => {
    el.setAttribute('value', '10');
    expect(el.value).toBeLessThanOrEqual(5);
  });
});
