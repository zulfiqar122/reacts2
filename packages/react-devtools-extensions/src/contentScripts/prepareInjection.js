/* global chrome */

import nullthrows from 'nullthrows';
import {SESSION_STORAGE_RELOAD_AND_PROFILE_KEY} from 'react-devtools-shared/src/constants';
import {sessionStorageGetItem} from 'react-devtools-shared/src/storage';
import {IS_FIREFOX, EXTENSION_CONTAINED_VERSIONS} from '../utils';

// We run scripts on the page via the service worker (backgroud.js) for
// Manifest V3 extensions (Chrome & Edge).
// We need to inject this code for Firefox only because it does not support ExecutionWorld.MAIN
// https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/scripting/ExecutionWorld
// In this content script we have access to DOM, but don't have access to the webpage's window,
// so we inject this inline script tag into the webpage (allowed in Manifest V2).
function injectScriptSync(src) {
  let code = '';
  const request = new XMLHttpRequest();
  request.addEventListener('load', function () {
    code = this.responseText;
  });
  request.open('GET', src, false);
  request.send();

  const script = document.createElement('script');
  script.textContent = code;

  // This script runs before the <head> element is created,
  // so we add the script to <html> instead.
  nullthrows(document.documentElement).appendChild(script);
  nullthrows(script.parentNode).removeChild(script);
}

let lastDetectionResult;

// We want to detect when a renderer attaches, and notify the "background page"
// (which is shared between tabs and can highlight the React icon).
// Currently we are in "content script" context, so we can't listen to the hook directly
// (it will be injected directly into the page).
// So instead, the hook will use postMessage() to pass message to us here.
// And when this happens, we'll send a message to the "background page".
window.addEventListener('message', function onMessage({data, source}) {
  if (source !== window || !data) {
    return;
  }
  switch (data.source) {
    case 'react-devtools-detector':
      lastDetectionResult = {
        hasDetectedReact: true,
        reactBuildType: data.reactBuildType,
      };
      chrome.runtime.sendMessage(lastDetectionResult);
      break;
    case 'react-devtools-extension':
      if (data.payload?.type === 'fetch-file-with-cache') {
        const url = data.payload.url;

        const reject = value => {
          chrome.runtime.sendMessage({
            source: 'react-devtools-content-script',
            payload: {
              type: 'fetch-file-with-cache-error',
              url,
              value,
            },
          });
        };

        const resolve = value => {
          chrome.runtime.sendMessage({
            source: 'react-devtools-content-script',
            payload: {
              type: 'fetch-file-with-cache-complete',
              url,
              value,
            },
          });
        };

        fetch(url, {cache: 'force-cache'}).then(
          response => {
            if (response.ok) {
              response
                .text()
                .then(text => resolve(text))
                .catch(error => reject(null));
            } else {
              reject(null);
            }
          },
          error => reject(null),
        );
      }
      break;
    case 'react-devtools-inject-backend-manager':
      if (IS_FIREFOX) {
        injectScriptSync(chrome.runtime.getURL('build/backendManager.js'));
      }
      break;
    case 'react-devtools-backend-manager':
      if (IS_FIREFOX) {
        data.payload?.versions?.forEach(version => {
          if (EXTENSION_CONTAINED_VERSIONS.includes(version)) {
            injectScriptSync(
              chrome.runtime.getURL(
                `/build/react_devtools_backend_${version}.js`,
              ),
            );
          }
        });
      }
      break;
  }
});

// NOTE: Firefox WebExtensions content scripts are still alive and not re-injected
// while navigating the history to a document that has not been destroyed yet,
// replay the last detection result if the content script is active and the
// document has been hidden and shown again.
window.addEventListener('pageshow', function ({target}) {
  if (!lastDetectionResult || target !== window.document) {
    return;
  }
  chrome.runtime.sendMessage(lastDetectionResult);
});

if (IS_FIREFOX) {
  // If we have just reloaded to profile, we need to inject the renderer interface before the app loads.
  if (
    sessionStorageGetItem(SESSION_STORAGE_RELOAD_AND_PROFILE_KEY) === 'true'
  ) {
    injectScriptSync(chrome.runtime.getURL('build/renderer.js'));
  }
  // Inject a __REACT_DEVTOOLS_GLOBAL_HOOK__ global for React to interact with.
  // Only do this for HTML documents though, to avoid e.g. breaking syntax highlighting for XML docs.
  switch (document.contentType) {
    case 'text/html':
    case 'application/xhtml+xml': {
      injectScriptSync(chrome.runtime.getURL('build/installHook.js'));
      break;
    }
  }
}
