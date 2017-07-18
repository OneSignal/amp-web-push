import { WorkerMessenger } from '../extensions/amp-web-push/0.1/worker-messenger';

/*
  The service worker listens to postMessage() messages sent from a lightweight
  invisible iframe on the canonical origin. The AMP page sends messages to this
  "helper" iframe, which then forwards the message to the service worker.
  Broadcast replies from the service worker are received by the helper iframe,
  which broadcasts the reply back to the AMP page.
 */

const WorkerMessengerCommand = {
  /*
    Used to request the current subscription state.
   */
  AMP_SUBSCRIPION_STATE: "amp-web-push-subscription-state",
  /*
    Used to request the service worker to subscribe the user to push.
    Notification permissions are already granted at this point.
   */
  AMP_SUBSCRIBE: "amp-web-push-subscribe",
  /*
    Used to unsusbcribe the user from push.
   */
  AMP_UNSUBSCRIBE: "amp-web-push-unsubscribe"
};

/*
  According to
  https://w3c.github.io/ServiceWorker/#run-service-worker-algorithm:

  "user agents are encouraged to show a warning that the event listeners
  must be added on the very first evaluation of the worker script."

  We have to register our event handler statically (not within an
  asynchronous method) so that the browser can optimize not waking up the
  service worker for events that aren't known for sure to be listened for.

  Also see: https://github.com/w3c/ServiceWorker/issues/1156
*/
// self.addEventListener('message') is statically added inside the listen()
// method
const workerMessenger = new WorkerMessenger();
workerMessenger.listen();

/*
  Broadcasts a single boolean describing whether the user is subscribed.
 */
workerMessenger.on(WorkerMessengerCommand.AMP_SUBSCRIPION_STATE, async () => {
  const pushSubscription = await self.registration.pushManager.getSubscription();
  if (!pushSubscription) {
    workerMessenger.broadcast(WorkerMessengerCommand.AMP_SUBSCRIPION_STATE, false);
  } else {
    const permission = await self.registration.pushManager.permissionState(pushSubscription.options);
    const isSubscribed = !!pushSubscription && permission === "granted";
    workerMessenger.broadcast(WorkerMessengerCommand.AMP_SUBSCRIPION_STATE, isSubscribed);
  }
});

/*
  Subscribes the visitor to push.

  The broadcast value is null (not used in the AMP page).
 */
workerMessenger.on(WorkerMessengerCommand.AMP_SUBSCRIBE, async () => {
  const subscription = await self.registration.pushManager.subscribe();
  // Forward the push subscription to your server here
  workerMessenger.broadcast(WorkerMessengerCommand.AMP_SUBSCRIBE, null);
});


/*
  Unsubscribes the subscriber from push.

  The broadcast value is null (not used in the AMP page).
 */
workerMessenger.on(WorkerMessengerCommand.AMP_UNSUBSCRIBE, async () => {
  const subscription = await self.registration.pushManager.subscribe();
  await subscription.unsubscribe();
  // Forward the unsubscription to your server here
  workerMessenger.broadcast(WorkerMessengerCommand.AMP_UNSUBSCRIBE, null);
});