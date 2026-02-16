export class StarRating extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    // TODO: implement - render 5 stars, handle click, support value attribute
  }

  static get observedAttributes() {
    return ['value'];
  }

  attributeChangedCallback(_name: string, _oldValue: string | null, _newValue: string | null) {
    // TODO: implement
  }

  get value(): number {
    return 0; // TODO: implement
  }

  set value(_val: number) {
    // TODO: implement
  }
}

customElements.define('star-rating', StarRating);
