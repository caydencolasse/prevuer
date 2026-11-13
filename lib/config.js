// Built-in service config. Everything here ships inside the extension, so anyone who installs
// it (or reads this repo) can see these values.

// Rotten Tomatoes scores and reviews via RapidAPI (https://rapidapi.com/matepapava123/api/rottentomato).
// Users can override it with their own key in Settings › API's.
export const RT_RAPIDAPI = {
  host: 'rottentomato.p.rapidapi.com',
  key: 'fb8a484cabmsh16b70e16133a14fp1408c6jsnd435e37500dd',
};

// prevueParty runs on Firebase Realtime Database with Anonymous sign-in. See README › prevueParty
// for setup. Both values come from Firebase console › Project settings › Your apps (web app).
export const FIREBASE = {
  apiKey: '',
  databaseURL: '', // e.g. https://your-project-default-rtdb.firebaseio.com
  authEmulator: '', // dev only: e.g. http://127.0.0.1:9099 to use the Firebase Auth emulator
};
