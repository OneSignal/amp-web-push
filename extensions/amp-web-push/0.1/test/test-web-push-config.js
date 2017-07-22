/**
 * Copyright 2017 The AMP HTML Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS-IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {WebPushService} from '../web-push-service';
import {TAG, CONFIG_TAG} from '../vars';
import {toggleExperiment} from '../../../../src/experiments';
import {WebPushConfigAttributes} from '../amp-web-push-config';

describes.realWin('web-push-config', {
  amp: true,
}, env => {
  let win;
  const webPushConfig = {};

  function setDefaultConfigParams_() {
    webPushConfig[WebPushConfigAttributes.HELPER_FRAME_URL] =
      'https://a.com/webpush/amp/helper?https=1';
    webPushConfig[WebPushConfigAttributes.PERMISSION_DIALOG_URL] =
      'https://a.com/webpush/amp/subscribe?https=1';
    webPushConfig[WebPushConfigAttributes.SERVICE_WORKER_URL] =
      'https://a.com/service-worker.js?param=value';
  }

  beforeEach(() => {
    win = env.win;
    setDefaultConfigParams_();
    toggleExperiment(env.win, TAG, true);
  });

  function createWebPushConfig(parameters) {
    const element = win.document.createElement(CONFIG_TAG);
    element.setAttribute(WebPushConfigAttributes.HELPER_FRAME_URL,
        parameters[WebPushConfigAttributes.HELPER_FRAME_URL]);
    element.setAttribute(WebPushConfigAttributes.PERMISSION_DIALOG_URL,
        parameters[WebPushConfigAttributes.PERMISSION_DIALOG_URL]);
    element.setAttribute(WebPushConfigAttributes.SERVICE_WORKER_URL,
        parameters[WebPushConfigAttributes.SERVICE_WORKER_URL]);
    win.document.body.appendChild(element);
    return element;
  }

  function removeAllWebPushConfigElements() {
    const elements = win.document.querySelectorAll(CONFIG_TAG);
    elements.forEach(element => element.remove());
  }

  afterEach(() => {
    toggleExperiment(env.win, TAG, false);
  });

  it('should fail if experiment is not enabled', () => {
    toggleExperiment(env.win, TAG, false);
    // Experiment check is bypassed on test mode -- make sure it isn't.
    window.AMP_MODE = {test: false};
    expect(() => {
      new WebPushService(env.ampdoc).ensureAmpExperimentEnabled_();
    }).to.throw(`Experiment "${TAG}" is disabled. Enable it on ` +
      'https://cdn.ampproject.org/experiments.html.');
  });

  it('should fail if element does not have correct ID', () => {
    env.ampdoc.whenReady().then(() => {
      expect(() => {
        const element = createWebPushConfig(webPushConfig);
        const webPushConfig = element.implementation_;
        webPushConfig.validate();
      }).to.throw(/must have an id attribute of value/);
    });
  });

  it('should fail if page contains duplicate element id', () => {
    env.ampdoc.whenReady().then(() => {
      expect(() => {
        createWebPushConfig();
        const element = createWebPushConfig(webPushConfig);
        const webPushConfig = element.implementation_;
        webPushConfig.validate();
      }).to.throw(/only one .* element may exist on a page/);
    });
  });

  it('should fail if any attribute is missing', () => {
    for (const attribute in WebPushConfigAttributes) {
      env.ampdoc.whenReady().then(() => {
        expect(() => {
          delete webPushConfig[attribute];
          const element = createWebPushConfig(webPushConfig);
          const webPushConfig = element.implementation_;
          webPushConfig.validate();
          removeAllWebPushConfigElements();
        }).to.throw(/attribute is required/);
      });
    }
  });

  it('should fail if any attribute is HTTP', () => {
    for (const attribute in WebPushConfigAttributes) {
      env.ampdoc.whenReady().then(() => {
        expect(() => {
          webPushConfig[attribute] = 'http://example.com/test';
          const element = createWebPushConfig(webPushConfig);
          const webPushConfig = element.implementation_;
          webPushConfig.validate();
          removeAllWebPushConfigElements();
        }).to.throw(/should begin with the https:\/\/ protocol/);
      });
    }
  });

  it('should fail if any attribute is site root page', () => {
    for (const attribute in WebPushConfigAttributes) {
      env.ampdoc.whenReady().then(() => {
        expect(() => {
          webPushConfig[attribute] = 'http://example.com/';
          const element = createWebPushConfig(webPushConfig);
          const webPushConfig = element.implementation_;
          webPushConfig.validate();
          removeAllWebPushConfigElements();
        }).to.throw(/and point to the/);
      });
    }
  });

  it('should fail if any attribute value\'s protocol is missing', () => {
    for (const attribute in WebPushConfigAttributes) {
      env.ampdoc.whenReady().then(() => {
        expect(() => {
          webPushConfig[attribute] = 'www.example.com/test';
          const element = createWebPushConfig(webPushConfig);
          const webPushConfig = element.implementation_;
          webPushConfig.validate();
          removeAllWebPushConfigElements();
        }).to.throw(/should begin with the https:\/\/ protocol/);
      });
    }
  });

  it('should fail if attribute origins differ', () => {
    webPushConfig[WebPushConfigAttributes.HELPER_FRAME_URL] =
      'https://another-origin.com/test';
    env.ampdoc.whenReady().then(() => {
      expect(() => {
        const element = createWebPushConfig(webPushConfig);
        const webPushConfig = element.implementation_;
        webPushConfig.validate();
      }).to.throw(/must all share the same origin/);
    });
  });

  it('should succeed for valid config', () => {
    env.ampdoc.whenReady().then(() => {
      const element = createWebPushConfig(webPushConfig);
      const webPushConfig = element.implementation_;
      webPushConfig.validate();
    });
  });
});
