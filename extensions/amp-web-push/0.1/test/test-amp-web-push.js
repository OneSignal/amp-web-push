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

import { WebPushService } from '../web-push-service';
import { TAG } from '../vars';
import * as sinon from 'sinon';
import {chunkInstanceForTesting} from '../../../../src/chunk';
import {installTimerService} from '../../../../src/service/timer-impl';
import {toArray} from '../../../../src/types';
import {toggleExperiment} from '../../../../src/experiments';
import {user} from '../../../../src/log';

describes.realWin('amp-web-push', {
  amp: {
    runtimeOn: false
  }
}, env => {
  let webPush;
  let win;
  let validConfigJson;

  beforeEach(() => {
    win = env.win;
    toggleExperiment(env.win, TAG, true);

    // Make sure we have a chunk instance for testing.
    chunkInstanceForTesting(env.ampdoc);

    webPush = new WebPushService(env.ampdoc);

    validConfigJson = {
      "helperIframeUrl": "https://example.com/webpush/amp/helper?https=1",
      "permissionDialogUrl": "https://example.com/webpush/amp/subscribe?https=1",
      "serviceWorkerUrl": "https://example.com/service-worker.js?param=value"
    };
  });

  afterEach(() => {
    toggleExperiment(env.win, TAG, false);
  });

  /**
   * @param {string} binding
   * @param {string=} opt_tagName
   * @return {!Element}
   */
  function createElementWithBinding(binding, opt_tagName) {
    const tag = opt_tagName || 'p';
    const div = env.win.document.createElement('div');
    div.innerHTML = `<${tag} ${binding}></${tag}>`;
    const newElement = div.firstElementChild;
    const parent = env.win.document.getElementById('parent');
    parent.appendChild(newElement);
    return newElement;
  }

  /**
   * Resolves when Bind service is fully initialized.
   * @return {!Promise}
   */
  function onBindReady() {
    return bind.initializePromiseForTesting().then(() => {
      env.flushVsync();
    });
  }

  it('should throw error if experiment is not enabled', () => {
    toggleExperiment(env.win, TAG, false);
    // Experiment check is bypassed on test mode -- make sure it isn't.
    window.AMP_MODE = {test: false};
    expect(() => {
      new WebPushService(env.ampdoc).ensureAmpExperimentEnabled_();
    }).to.throw(`Experiment "${TAG}" is disabled. Enable it on https://cdn.ampproject.org/experiments.html.`);
  });

  it('should error if missing a script element with ID amp-web-push', () => {
    expect(() => {
      const div = env.win.document.createElement('script');
      div.id = 'amp-web-push-config-missing';
      env.win.document.querySelector('head').appendChild(div);
      webPush.getConfigAsText(env.win.document);
    }).to.throw(`Your AMP document must include a <script ` +
    `id="amp-web-push" type="application/json">.`);
  });

  it('should find a script element with ID amp-web-push', () => {
      const div = env.win.document.createElement('script');
      const content = "This is some content.";
      div.innerHTML = content;
      div.id = 'amp-web-push';
      env.win.document.querySelector('head').appendChild(div);
      expect(content).to.deep.equal(webPush.getConfigAsText(env.win.document));
  });

  it('should not parse empty JSON', () => {
    expect(() => {
      webPush.parseConfigJson('');
    }).to.throw(`Your AMP document's configuration JSON ` +
      `must not be empty.`);
  });

  it('should not parse invalid JSON', () => {
    expect(() => {
      webPush.parseConfigJson('asdf');
    }).to.throw(new RegExp(`Your AMP document's configuration JSON ` +
    `must be valid JSON. Failed to parse JSON`));
  });

  it('should fail if config JSON is missing helperIframeUrl property', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      delete configJson.helperIframeUrl;
      webPush.parseConfigJson(JSON.stringify(configJson));
    }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid helperIframeUrl property. It should begin with the https:// ` +
      `protocol and point to the provided lightweight template page provided for ` +
      `AMP messaging.`);
  });

  it('should fail if config JSON helperIframeUrl is HTTP', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      configJson.helperIframeUrl = 'http://example.com/helper-iframe.html';
      webPush.parseConfigJson(JSON.stringify(configJson));
    }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid helperIframeUrl property. It should begin with the https:// ` +
      `protocol and point to the provided lightweight template page provided for ` +
      `AMP messaging.`);
  });

  it('should fail if config JSON is helperIframeUrl points to site root', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      configJson.helperIframeUrl = 'https://site.com'; // Needs protocol https:// or http://
      webPush.parseConfigJson(JSON.stringify(configJson));
    }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid helperIframeUrl property. It should begin with the https:// ` +
      `protocol and point to the provided lightweight template page provided for ` +
      `AMP messaging.`);
  });

  it('should fail if config JSON is missing permissionDialogUrl property', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      delete configJson.permissionDialogUrl;
      webPush.parseConfigJson(JSON.stringify(configJson));
      }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid permissionDialogUrl property. It should begin with the https:// ` +
      `protocol and point to the provided template page for showing the permission prompt.`);
  });

  it('should fail if config JSON is permissionDialogUrl is missing protocol', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      configJson.permissionDialogUrl = 'www.site.com/test'; // Needs protocol https:// or http://
      webPush.parseConfigJson(JSON.stringify(configJson));
    }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid permissionDialogUrl property. It should begin with the https:// ` +
      `protocol and point to the provided template page for showing the permission prompt.`);
  });

  it('should fail if config JSON is missing serviceWorkerUrl property', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      delete configJson.serviceWorkerUrl;
      webPush.parseConfigJson(JSON.stringify(configJson));
    }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid serviceWorkerUrl property. It should begin with the https:// ` +
      `protocol and point to the service worker JavaScript file to be installed.`);
  });

  it('should fail if config JSON serviceWorkerUrl is HTTP', () => {
    expect(() => {
      let configJson = Object.assign({}, validConfigJson);
      configJson.serviceWorkerUrl = 'http://example.com/service-worker.js';
      webPush.parseConfigJson(JSON.stringify(configJson));
    }).to.throw(`Your AMP document's configuration ` + `JSON must ` +
      `have a valid serviceWorkerUrl property. It should begin with the https:// ` +
      `protocol and point to the service worker JavaScript file to be installed.`);
  });

  it('should parse valid config JSON', () => {
    const parsedConfigJson = webPush.parseConfigJson(JSON.stringify(validConfigJson));
    expect(parsedConfigJson).to.deep.equal(parsedConfigJson);
  });
});
