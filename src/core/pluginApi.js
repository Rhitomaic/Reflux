/**
 * src/core/pluginApi.js
 *
 * Convenience entry point for main-process plugins.
 *
 *   const {definePlugin, OptionType} = require('../../core/pluginApi');
 *
 *   module.exports = definePlugin({
 *     name: 'myPlugin',
 *     settings: {
 *       enabledThing: {
 *         type: OptionType.BOOLEAN,
 *         description: '...',
 *         default: true,
 *       },
 *     },
 *     start() {},
 *     stop() {},
 *   });
 */

'use strict';

const schema = require('./pluginSchema');
const pluginSettings = require('./pluginSettings');

module.exports = {
  ...schema,
  createSettingsStore: pluginSettings.createStore,
};
