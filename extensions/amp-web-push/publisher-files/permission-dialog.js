class AmpWebPushPermissionDialog {
  constructor(options) {
    if (options && options.debug) {
      // Debug enables verbose logging for this page and the window and worker
      // messengers
      this.debug = true;
    }

    // For communication between the AMP page and this permission dialog
    this.ampMessenger = new WindowMessenger({
      debug: this.debug
    });
  }

  isCurrentDialogPopup() {
    return !!window.opener &&
      window.opener !== window;
  }

  requestNotificationPermission() {
    return new Promise((resolve, reject) => {
      try {
        Notification.requestPermission(permission => resolve(permission));
      } catch (e) {
        reject(e);
      }
    });
  }

  /**
   * Parses the query string of an URL. This method returns a simple key/value
   * map. If there are duplicate keys the latest value is returned.
   *
   * This function is implemented in a separate file to avoid a circular
   * dependency.
   *
   * @param {string} queryString
   * @return {!Object<string>}
   */
  parseQueryString(queryString) {
    const params = Object.create(null);
    if (!queryString) {
      return params;
    }

    let match;
    const regex = /(?:^[#?]?|&)([^=&]+)(?:=([^&]*))?/g;
    while ((match = regex.exec(queryString))) {
      const name = decodeURIComponent(match[1]).trim();
      const value = match[2] ? decodeURIComponent(match[2]).trim() : '';
      params[name] = value;
    }
    return params;
  }

  run() {
    if (this.isCurrentDialogPopup()) {
      this.ampMessenger.connect(opener, '*');

      this.requestNotificationPermission().then(permission => {
        return this.ampMessenger.send(
          WindowMessenger.Topics.NOTIFICATION_PERMISSION_STATE,
          permission
        );
      }).then(([message, _]) => {
        if (message && message.closeFrame) {
          window.close();
        }
      });
    } else {
      const queryParams = this.parseQueryString(window.location.search);
      if (!queryParams['return']) {
        throw new Error('Expecting return URL query parameter to redirect back.');
      }
      this.requestNotificationPermission().then(permission => {
        window.location.href = decodeURIComponent(queryParams['return']);
      });
    }
  }
}

new AmpWebPushPermissionDialog({
  debug: true
}).run();
