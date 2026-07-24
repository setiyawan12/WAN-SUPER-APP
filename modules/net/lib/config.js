'use strict';

module.exports = {
  TUNNEL_PORT : parseInt(process.env.TUNNEL_PORT  || '3000', 10),
  CLIENT_PORT : parseInt(process.env.CLIENT_PORT  || '4040', 10),
  INSP_PASS   : process.env.INSPECTOR_PASS || '',
  MAX_LOG     : 500,
};
