module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Unistyles must see every file that calls StyleSheet.create. All app code lives in src/.
    plugins: [['react-native-unistyles/plugin', { root: 'src' }]],
  };
};
