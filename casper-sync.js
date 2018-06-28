'esversion: 6';

var ATTRIBUTES = require('./attributes');
var TDAPI = require('tdapi');
var request = require('request-promise');
var moment = require('moment');
var tdDateFormat = 'MM/DD/Y h:mm A';
var config = require('./config');

if (process.env.NODE_ENV == 'production') {
  var TD_API_BASE_URL = 'https://oregonstate.teamdynamix.com/TDWebApi/api';
} else {
  var TD_API_BASE_URL = 'https://oregonstate.teamdynamix.com/SBTDWebApi/api';
}

var CASPER_REPORT_IDS = [38, 45];

var td = new TDAPI({
  baseUrl: TD_API_BASE_URL,
  credentials: config.tdCredentials
});

// Temporary function until the tdapi gets updated to contain it ////
TDAPI.prototype.getProductModel = function(id) {
  return this.login()
  .then(bearerToken => {
    return request({
      method: 'GET',
      url: `${this.baseUrl}/assets/models/${id}`,
      auth: { bearer: bearerToken },
      json: true
    });
  })
  .catch();
};

TDAPI.prototype.editProductModel = function(productModel) {
  return this.login()
  .then(bearerToken => {
    return request({
      method: 'PUT',
      url: `${this.baseUrl}/assets/models/${productModel.ID}`,
      auth: { bearer: bearerToken },
      json: true,
      body: productModel || {}
    });
  })
  .catch();
};
//////////////////////////////////////////////////////////////

var tdAssets;
var tdUsers;
var tdVendors;
var tdModels;
var casperAssets = [];
var productModels = [];

async function syncAssets() {
  try {
    for (let id of CASPER_REPORT_IDS){
      let casperReponse = await request({
        url: `${config.casper.url}${id}`,
        method: 'GET',
        auth: config.casperAuth,
        headers: {
          'Accept': 'application/json'
        },
        strictSSL: false
      });

      casperAssets = casperAssets.concat(JSON.parse(casperReponse)['computer_reports']);
    }

    
    // Get TD assets from TD API
    tdAssets = await td.getReport(91998, true, undefined);
    tdAssets = tdAssets.DataRows;

    // Get TD vendor and model data from API
    // Note: This data is used to retrieve the IDs required by TD to
    //       fill out the vendor or model field on an asset.
    tdVendors = await td.getVendors();
    tdModels = await td.getProductModels();
    // Get TD users from API for setting user associations
    tdUsers = await td.getUsers();

    await processNewAssets();
    await processAssetUpdates();
    await updateProductModelAge();
  } catch (err) {
    console.error(err);
  }
}

async function processNewAssets() {
  try {
    for (let i = 0; i < casperAssets.length; i++) {
      let casperAsset = casperAssets[i];

      // Check for match on JSS ID
      let existingAsset = tdAssets.find(item => casperAsset['JSS_Computer_ID'] == item['ExternalID']);

      // If no match on JSS ID, check for match on SerialNumber
      if (!existingAsset) {
        existingAsset = tdAssets.find(item => casperAsset['Serial_Number'] == item['SerialNumber']);
      }

      if (existingAsset && (existingAsset['ExternalID'] != casperAsset['JSS_Computer_ID'])) {
        let fullTDAsset = await td.getAsset(existingAsset['AssetID']);
        fullTDAsset['ExternalID'] = casperAsset['JSS_Computer_ID'];
        let updatedAsset = await updateAsset(fullTDAsset);
        console.log(`Asset #${updatedAsset['ID']} - Rebuild, tagged with new ExternalID`);
      }

      // No match on JSS ID, create new Asset
      if (!existingAsset) {
        let userEmailAddress = casperAsset['Email_Address'] || '';
        userEmailAddress = userEmailAddress.toLowerCase();
        if (userEmailAddress && userEmailAddress.indexOf('@onid') > -1) {
          userEmailAddress = userEmailAddress.split('@onid')[0] + '@oregonstate.edu';
        }

        let newAsset = {
          StatusID: ATTRIBUTES.status.active,
          ExternalID: casperAsset['JSS_Computer_ID'],
          SerialNumber: casperAsset['Serial_Number'] || '',
          Name: casperAsset['Computer_Name'],
          Attributes: [{
            ID: ATTRIBUTES.cpu,
            Value: casperAsset['Processor_Type'] || ''
          }, {
            ID: ATTRIBUTES.ram,
            Value: casperAsset['Total_RAM_MB'] || ''
          }, {
            ID: ATTRIBUTES.mac0,
            Value: casperAsset['MAC_Address'] || ''
          }, {
            ID: ATTRIBUTES.operatingSystem,
            Value: casperAsset['Operating_System'] || ''
          }, {
            ID: ATTRIBUTES.externalSource,
            Value: 'Casper'
          }, {
            ID: ATTRIBUTES.primaryuser,
            Value: userEmailAddress || ''
          }, {
            ID: ATTRIBUTES.cyder,
            Value: `https://cyder.oregonstate.edu/search/?search=${casperAsset['MAC_Address']}`
          }, {
            ID: ATTRIBUTES.warranty,
            Value: casperAsset['Warranty_Expiration'] || ''
          }]
        };

        // Set owner and owning department if matching TD user for machine primary user
        // Note: Exclude students and users with no department set
        if (userEmailAddress) {
          let user = tdUsers.filter(e => e['PrimaryEmail'].toLowerCase() == userEmailAddress || e['AlertEmail'].toLowerCase() == userEmailAddress)[0];
          let hasDepartment = user && user['DefaultAccountName'] && user['DefaultAccountName'] !== 'None';
          let isStudent = user && user['DefaultAccountName'] && user['DefaultAccountName'].toLowerCase().includes('major');

          if (hasDepartment && !isStudent) {
            newAsset['OwningCustomerID'] = user['UID'];
            newAsset['OwningDepartmentID'] = user['DefaultAccountID'];
          }
        }

        // Add vendor info
        let vendor = tdVendors.find(item => item['Name'].includes(casperAsset['Make']));
        if (vendor) {
          newAsset['SupplierID'] = vendor['ID'];
        }

        // Add model info
        let model = tdModels.find(item => item.Name == casperAsset['Model_Identifier']);
        if (model) {
          newAsset['ProductModelID'] = model['ID'];
        }

        // Create asset if name and serialnumber are specified
        // Note: TD requires one of these fields to be set to allow creation
        if (newAsset['SerialNumber'] && newAsset['Name']) {
          let createdAsset = await delay(createAsset, newAsset);
          if (createdAsset && createdAsset['ID']) {
            // Add CN Label field to new asset and update
            // Note: Requires an extra API call after initial creation - needs ID from creation to create link
            let printCNLabel = createdAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.printCNLabel);
            if (!printCNLabel) {
              createdAsset['Attributes'].push({ID: ATTRIBUTES.printCNLabel, Value: `https://tools.is.oregonstate.edu/td-asset-labels/${createdAsset['ID']}`});
              await updateAsset(createdAsset);
              console.log(`Asset #${createdAsset['ID']} created.`);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
}

async function processAssetUpdates() {
  try {
    for (let i = 0; i < tdAssets.length; i++) {
      let tdAsset = tdAssets[i];

      // Find matching Casper asset for existing TD asset
      let casperAsset = casperAssets.find(item => item['JSS_Computer_ID'] == tdAsset['ExternalID']);
      

      // If no record in Casper, deactivate asset in TD
      if (!casperAsset) {
        if (tdAsset['StatusName'] !== 'Retired') {
          let fullTDAsset = await td.getAsset(tdAsset['AssetID']);
          fullTDAsset['StatusID'] = ATTRIBUTES.status.inactive;
          let updatedAsset = await delay(updateAsset, fullTDAsset);
          if (updatedAsset) {
            console.log(`Asset #${updatedAsset['ID']} no longer found in Casper - marked as inactive.`);
          }
        }
        continue;
      }

      if (casperAsset && tdAsset['StatusName'] == 'Retired') {
        let fullTDAsset = await td.getAsset(tdAsset['AssetID']);
        fullTDAsset['StatusID'] = ATTRIBUTES.status.active;
        let updatedAsset = await delay(updateAsset, fullTDAsset);
        if (updatedAsset) {
          console.log(`Asset #${updatedAsset['ID']} found in Casper, but inactive in TD - marked as active.`);
        }
        continue;
      }

      // Check if Casper-tracked asset marked inactive
      let isMarkedActive = tdAsset['StatusName'] == 'In Use' ||
                           tdAsset['StatusName'] == 'Loaner - Checked Out' ||
                           tdAsset['StatusName'] == 'Loaner - Available' ||
                           tdAsset['StatusName'] == 'Loaner - Unavailable';

      // Check if TD hostname matches Casper hostname
      let nameMatches = casperAsset['Computer_Name'] == tdAsset['Name'];

      // Check if vendor info matches
      let vendorMatches = true;
      let vendor = tdVendors.find(item => item['Name'] == casperAsset['Make']);
      if (vendor) {
        vendorMatches = tdAsset['ManufacturerName'].toLowerCase() == casperAsset['Make'].toLowerCase();
      }

      // Check if model info matches
      let modelMatches = true;
      let model = tdModels.find(item => item['Name'] == casperAsset['Model_Identifier']);
      if (model) {
        modelMatches = tdAsset['ProductModelName'].toLowerCase() == casperAsset['Model_Identifier'].toLowerCase();
      }

      // Check if CPU info matches
      let cpuMatches = true;
      if (casperAsset['Processor_Type']) {
        cpuMatches = tdAsset[ATTRIBUTES.cpu] && tdAsset[ATTRIBUTES.cpu] == casperAsset['Processor_Type'];
      }

      // Check if memory info matches
      let memoryMatches = true;
      if (casperAsset['Total_RAM_MB']) {
        memoryMatches = tdAsset[ATTRIBUTES.ram] && tdAsset[ATTRIBUTES.ram] == casperAsset['Total_RAM_MB'];
      }

      // Check if Cyder link populated
      let cyderLink = tdAsset[ATTRIBUTES.cyder] ? true : false;

      // Check if primary user and owning customer match
      let primaryUserMatches = true;
      let owningCustomerMatches = true;

      if (casperAsset['Email_Address'] && casperAsset['Email_Address'].indexOf('@onid') > -1) {
        casperAsset['Email_Address'] = casperAsset['Email_Address'].split('@onid')[0] + '@oregonstate.edu';
      }

      casperAsset['Email_Address'] = casperAsset['Email_Address'].toLowerCase();

      let username = casperAsset['Email_Address'];
      let user = tdUsers.filter(user => user['PrimaryEmail'].toLowerCase() == username || user['AlertEmail'].toLowerCase() == username)[0];
      
      if(username && user) {
        let hasDepartment = user && user['DefaultAccountName'] && user['DefaultAccountName'] !== 'None';
        let isStudent = user && user['DefaultAccountName'] && user['DefaultAccountName'].toLowerCase().includes('major');
        primaryUserMatches = tdAsset[ATTRIBUTES.primaryuser] && tdAsset[ATTRIBUTES.primaryuser] == casperAsset['Email_Address'];

        // Update owner and owning department if changed (and primary user hasn't changed) - Do not sync if flagged as general use
        let isGeneralUse = tdAsset[ATTRIBUTES.generalUse] == 'Yes';

        if ((hasDepartment && !isStudent && !isGeneralUse) && tdAsset['OwningCustomerName'] !== user['FullName']) {
          owningCustomerMatches = false;
        }
      }

      if (
        !isMarkedActive ||
        !nameMatches ||
        !vendorMatches ||
        !modelMatches ||
        !cpuMatches ||
        !memoryMatches ||
        !cyderLink ||
        !primaryUserMatches ||
        !owningCustomerMatches
      ) {
        console.log(`Asset #${tdAsset['AssetID']}\n===================`);
        console.log(`
        isMarkedActive:        ${isMarkedActive}
        nameMatches:           ${nameMatches}
        vendorMatches:         ${vendorMatches}
        modelMatches:          ${modelMatches}
        cpuMatches:            ${cpuMatches}
        memoryMatches:         ${memoryMatches}
        cyderLink:             ${cyderLink}
        primaryUserMatches:    ${primaryUserMatches}
        owningCustomerMatches: ${owningCustomerMatches}
        `)
        let fullTDAsset = await td.getAsset(tdAsset['AssetID']);

        if (!isMarkedActive) {
          fullTDAsset['StatusID'] = ATTRIBUTES.status.active;
        }

        if (!nameMatches) {
          fullTDAsset['Name'] = casperAsset['Computer_Name'];
        }

        if (!vendorMatches) {
          fullTDAsset['SupplierID'] = vendor['ID'];
        }

        if (!modelMatches) {
          fullTDAsset['ProductModelID'] = model['ID'];
        }

        if (!cpuMatches) {
          let attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.cpu);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.cpu, Value: ''});
            attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.cpu);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = casperAsset['Processor_Type'].trim();
        }

        if (!memoryMatches) {
          let attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.ram);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.ram, Value: ''});
            attr = fullTDAsset['Attributes'].find(e =>e['ID'] == ATTRIBUTES.ram);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = casperAsset['Total_RAM_MB'];
        }

        if (!cyderLink) {
          let attr = fullTDAsset['Attributes'].find(e=> e['ID'] == ATTRIBUTES.cyder);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.cyder, Value: ''});
            attr = fullTDAsset['Attributes'].find(e=> e['ID'] == ATTRIBUTES.cyder);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = `https://cyder.oregonstate.edu/search/?search=${casperAsset['MAC_Address']}`;
        }

        if (!primaryUserMatches) {
          let attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.primaryuser);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.primaryuser, Value: ''});
            attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.primaryuser);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = casperAsset['Email_Address'];
        }

        if (!owningCustomerMatches) {
          fullTDAsset['OwningCustomerID'] = user['UID'];
        }

        let updatedAsset = await delay(updateAsset, fullTDAsset);
        if (updatedAsset) {
          console.log(`Asset #${updatedAsset['ID']} updated.`);
        } 
      }
    }
  } catch (err) {
    console.error(err);
  }
}
async function updateProductModelAge() {
  
  
  var report = (await td.getReport(102580,true)).DataRows;
  var mergedReport = [];
  var reportNames = report.map(e => {return e.ProductModelName});
  var tdModelNames = tdModels.map(e => {return e.Name.toLowerCase()});
  var macModelNames = casperAssets.map(e => {return e.Model_Identifier.toLowerCase()});
  var casperModelYear = casperAssets.map(e => e.Model.slice(-5).slice(0,4));

  // join casper to report to asset info
  for (let i = 0; i < report.length; i++) {
    let index = macModelNames.indexOf(reportNames[i].toLowerCase());
    let assetIndex = tdModelNames.indexOf(reportNames[i].toLowerCase());
    if (index > -1 && assetIndex > -1 && Object.values(report[i])[1] == null )  {
      let entry = {ID: tdModels[assetIndex].ID, Name: reportNames[i], age: casperModelYear[index]};
      if (mergedReport.findIndex(e => e.Name === reportNames[i]) === -1) {
        mergedReport.push(entry);
      }
    }
  }

  // update entries in TD
  if (mergedReport.length) {
    mergedReport.forEach(async e => {
      let productModel = await td.getProductModel(e.ID);
      let index = productModel.Attributes.findIndex(f => f.ID == 53562);
      productModel.Attributes[index].Value = `01/01/${e.age}`;
      td.editProductModel(productModel);
    });
  }
}

function createAsset(asset) {
  return td.createAsset(asset);
}

function updateAsset(asset) {
  return td.editAsset(asset.ID, asset);
}

function timeout(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function delay(fn, ...args) {
  await timeout(1000);
  return fn(...args);
}

syncAssets();