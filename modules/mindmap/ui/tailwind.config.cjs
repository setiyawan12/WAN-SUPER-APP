const path = require('node:path');

module.exports = {
  content: [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'js/**/*.js'),
  ],
  theme: {
    extend: {},
  },
  plugins: [],
};