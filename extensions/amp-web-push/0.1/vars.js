/** @const */
export const EXPERIMENT = 'amp-web-push';

/** @const */
export const TAG = 'amp-web-push';

export const WIDGET_TAG = TAG + '-widget';

export const NotificationPermission = {
  GRANTED: 'granted',
  DENIED: 'denied',
  /*
    Note: PushManager.permissionState() returns 'prompt';
    Notification.permission returns 'default'
   */
  DEFAULT: 'default'
}
