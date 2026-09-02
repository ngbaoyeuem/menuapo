(function() {
    'use strict';
    try {
        if (window.__ApoCrusherInjected__) return;
        window.__ApoCrusherInjected__ = true;
        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('hellfire.js');
        script.async = false;
        script.onload = function() { this.remove(); };
        (document.head || document.documentElement).appendChild(script);
    } catch(e) {}
})();
