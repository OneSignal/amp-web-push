import { TAG } from './vars';
import { Layout } from '../../../src/layout';


export const WebPushWidgetVisibilities = {
  /**
   * Describes the state when the user is subscribed.
   */
  SUBSCRIBED: 'subscribed',
  /**
   * Describes the state when the user is not subscribed.
   */
  UNSUBSCRIBED: 'unsubscribed',
  /**
   * Widgets shown when the user has blocked permissions, or has tried
   * subscribing in Incognito mode.
   */
  BLOCKED: 'blocked',
}

export class WebPushWidget extends AMP.BaseElement {

  /** @param {!AmpElement} element */
  constructor(element) {
    super(element);
  }

  /** @override */
  isLayoutSupported(layout) {
    return layout == Layout.FIXED;
  }

  /** @override */
  buildCallback() {
    // Hide the element
    this.element.classList.add('invisible');
  }
}
