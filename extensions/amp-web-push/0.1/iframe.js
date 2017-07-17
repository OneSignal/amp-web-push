export default class IFrame {
  constructor(document, url) {
    this.document = document;
    this.url = url;
    this.state = 'new';
    this.domElement = null;
    this.loadPromise = null;
  }

  load() {
    this.domElement = this.document.createElement('iframe');
    this.domElement.style.display = 'none';
    this.domElement.sandbox = 'allow-same-origin allow-scripts';
    this.domElement.src = this.url;

    this.document.body.appendChild(this.domElement);

    this.loadPromise = new Promise((resolve, reject) => {
      this.domElement.onerror = e => {
        this.state = 'error';
        reject(e);
      };
      this.domElement.onload = () => {
        this.state = 'loaded';
        resolve();
      };
    });
    return this.loadPromise;
  }

  whenReady() {
    return this.loadPromise;
  }
}
