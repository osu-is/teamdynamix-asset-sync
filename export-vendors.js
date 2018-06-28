
'esversion: 6';

var fs = require('fs');
var sql = require('mssql');
var TDAPI = require('tdapi');
var config = require('./config');
var Promise = require('bluebird');
var xlsx = require('xlsx');
var request = require('request-promise');

var td = new TDAPI({
  baseUrl: 'https://oregonstate.teamdynamix.com/TDWebApi/api',
  credentials: config.tdCredentials
});

var sqlConfig = {
  user: config.sqlConfig.user,
  password: config.sqlConfig.password,
  server: config.sqlConfig.ip,
  instanceName: 'CM_OCM',
  encrypt: true,
  domain: 'oregonstate.edu'
};

var CASPER_REPORT_ID = 38;

(async () => {
  try {
    // Get SCCM assets from SCCM SQL database
    let sccmQuery = await readFile('sccm-query.sql');
    let pool = await sql.connect(sqlConfig);
    let sccmResult = await pool.request().query(sccmQuery);
    let sccmAssets = sccmResult.recordset;
    pool.close();

    let casperReponse = await request({
      url: `${config.casper.url}${CASPER_REPORT_ID}`,
      method: 'GET',
      auth: config.casperAuth,
      headers: {
        'Accept': 'application/json'
      },
      strictSSL: false
    });

    let casperAssets = JSON.parse(casperReponse)['computer_reports'];

    let tdVendors = await td.getVendors();
    let tdModels = await td.getProductModels();

    let vendors = [
      ['Name', 'Is Manufacturer', 'Active']
    ];

    let models = [
      ['Name', 'Manufacturer', 'Product Type', 'Active']
    ];

    for (let i = 0; i < sccmAssets.length; i++) {
      let sccmAsset = sccmAssets[i];

      let vendorName = sccmAsset['ComputerSystem-Manufacturer'] || '';
      let existingVendor = tdVendors.find(item => item.Name == vendorName);
      let vendorInQueue = vendors.find(e => e[0] == vendorName);
      if (!existingVendor && vendorName && !vendorInQueue) {
        vendors.push([vendorName, 'True', 'True']);
      }

      let modelName = sccmAsset['ComputerSystem-Model'] || '';
      let existingModel = tdModels.find(item => item.Name == modelName);
      let modelInQueue = models.find(e => e[0] == modelName);
      if (!existingModel && modelName && !modelInQueue) {
        models.push([modelName, vendorName, 'Computer', 'True']);        
      }
    }

    for (let i = 0; i < casperAssets.length; i++) {
      let casperAsset = casperAssets[i];

      let vendorName = 'Apple Inc.';
      let existingVendor = tdVendors.find(item => item.Name == vendorName);
      let vendorInQueue = vendors.find(e => e[0] == vendorName);
      if (!existingVendor && vendorName && !vendorInQueue) {
        vendors.push([vendorName, 'True', 'True']);
      }

      let modelName = casperAsset['Model_Identifier'];
      let existingModel = tdModels.find(item => item.Name == modelName);
      let modelInQueue = models.find(e => e[0] == modelName);
      if (!existingModel && modelName && !modelInQueue) {
        models.push([modelName, vendorName, 'Computer', 'True']);
      }
    }

    let wb = xlsx.utils.book_new();
    let vendorSheet = xlsx.utils.aoa_to_sheet(vendors);
    xlsx.utils.book_append_sheet(wb, vendorSheet, 'Vendor');
    xlsx.writeFile(wb, 'vendors.xlsx');

    wb = xlsx.utils.book_new();
    let modelSheet = xlsx.utils.aoa_to_sheet(models);
    xlsx.utils.book_append_sheet(wb, modelSheet, 'Product Model');
    xlsx.writeFile(wb, 'models.xlsx');

  } catch (err) {
    console.error(err);
  }
})();

function readFile(fileName) {
  return new Promise((resolve, reject) => {
    fs.readFile(fileName, 'utf-8', (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(data);
      }
    });
  });
}