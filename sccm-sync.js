'esversion: 6';

var ATTRIBUTES = require('./attributes');
var fs = require('fs');
var path = require('path');
var sql = require('mssql');
var TDAPI = require('tdapi');
var config = require('./config');
var Promise = require('bluebird');
var moment = require('moment');
var tdDateFormat = 'MM/DD/Y h:mm A';

if (process.env.NODE_ENV == 'production') {
  var TD_API_BASE_URL = 'https://oregonstate.teamdynamix.com/TDWebApi/api';
} else {
  var TD_API_BASE_URL = 'https://oregonstate.teamdynamix.com/SBTDWebApi/api';
}

var td = new TDAPI({
  baseUrl: TD_API_BASE_URL,
  credentials: config.tdCredentials
});

var tdAssets;
var tdUsers;
var tdVendors;
var tdModels;
var sccmAssets;

module.exports = {
  getSccmAssets: getSccmAssets
};

async function getSccmAssets() {

  var sqlConfig = {
    user: config.sqlConfig.user,
    password: config.sqlConfig.password,
    server: config.sqlConfig.ip,
    instanceName: 'CM_OCM',
    encrypt: true,
    domain: 'oregonstate.edu',
    requestTimeout: 60000
  };
  
  let sccmQuery = await readFile(path.resolve(__dirname, 'sccm-query.sql'));
  let pool = await sql.connect(sqlConfig);
  let sccmResults = await pool.request().query(sccmQuery);
  sql.close();

  return sccmResults.recordset;
}

async function syncAssets() {
  try {
    console.log('Beginning SCCM asset sync.');

    console.log('Getting SCCM asset data...');
    // Get SCCM assets from SCCM SQL database
    sccmAssets = await getSccmAssets();

    //Filter out old SCCM entries with matching serial numbers but older creation dates
    sccmAssets = sccmAssets.filter(asset => {
      let match = sccmAssets.find(item => asset['SerialNumber'] == item['SerialNumber']
                                          && asset['ResourceID'] != item['ResourceID']);

      return !match || (new Date(asset.Creation_Date) > new Date(match.Creation_Date));
    });

    // Get TD assets from TD API
    console.log('Getting TD asset data...');
    tdAssets = await (td.getReport(91997, true, undefined));
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
  } catch (err) {
    console.error(err);
  }
}

async function processNewAssets() {
  try {
    let assetsToCreate = [];

    for (let i = 0; i < sccmAssets.length; i++) {
      let sccmAsset = sccmAssets[i];

      let existingAsset = tdAssets.find(item => sccmAsset.ResourceID == item.ExternalID);
      let validSerial = sccmAsset['SerialNumber'] && sccmAsset['SerialNumber'].match(/^[a-zA-Z0-9]{7,}$/);

      if (!existingAsset && validSerial) {
        // If no match on SCCM ID, check for match on SerialNumber
        // Note: If serial is invalid (likely results in duplicates / updating wrong entry), need to create new asset
        existingAsset = tdAssets.find(item => sccmAsset['SerialNumber'] == item['SerialNumber']);
      }

      if (existingAsset && (existingAsset['ExternalID'] != sccmAsset['ResourceID'])) {
        let fullTDAsset = await td.getAsset(existingAsset['AssetID']);
        fullTDAsset['ExternalID'] = sccmAsset['ResourceID'];
        let updatedAsset = await updateAsset(fullTDAsset);
        console.log(`Asset #${updatedAsset['ID']} - Rebuild, tagged with new ExternalID`);
      }

      let hasHostname = sccmAsset['Name'] && !sccmAsset['Name'].includes('minint');
      let isMac = (sccmAsset['ComputerSystem-Manufacturer'] && sccmAsset['ComputerSystem-Manufacturer'].toLowerCase().includes('apple'));
      let isMacModel = sccmAsset['ComputerSystem-Model'] &&
                           (sccmAsset['ComputerSystem-Model'].toLowerCase().includes('imac')
                            || sccmAsset['ComputerSystem-Model'].toLowerCase().includes('macbook')
                            || sccmAsset['ComputerSystem-Model'].toLowerCase().includes('macmini'));

      if (!validSerial || !hasHostname) {
        continue;
      }

      if (!existingAsset && hasHostname && !isMac && !isMacModel) {
        let newAsset = {
          StatusID: ATTRIBUTES.status.active, // Active
          ExternalID: sccmAsset['ResourceID'],
          SerialNumber: sccmAsset['SerialNumber'] || '',
          Name: sccmAsset['Name'] ? sccmAsset['Name'] : sccmAsset['Netbios_Name'] ? sccmAsset['Netbios_Name'] : '',
          Attributes: [{
            ID: ATTRIBUTES.cpu,
            Value: sccmAsset['CPU-Name'] || ''
          },{
            ID: ATTRIBUTES.ram,
            Value: sccmAsset['Memory-Installed'] || ''
          }, {
            ID: ATTRIBUTES.adapter0Name,
            Value: sccmAsset['NetworkAdapter0-Name'] || '',
          }, {
            ID: ATTRIBUTES.mac0,
            Value: sccmAsset['NetworkAdapter0-MACAddress'] || ''
          }, {
            ID: ATTRIBUTES.adapter1Name,
            Value: sccmAsset['NetworkAdapter1-Name'] || ''
          }, {
            ID: ATTRIBUTES.mac1,
            Value: sccmAsset['NetworkAdapter1-MACAddress'] || ''
          }, {
            ID: ATTRIBUTES.operatingSystem,
            Value: sccmAsset['OS-Caption'] || ''
          }, {
            ID: ATTRIBUTES.externalSource,
            Value: 'SCCM'
          }, {
            ID: ATTRIBUTES.primaryuser,
            Value: sccmAsset['Primary-Username'] || ''
          }, {
            ID: ATTRIBUTES.activeDirectoryOU,
            Value: sccmAsset['OU_Name'] || ''
          }, {
            ID: ATTRIBUTES.cyder,
            Value: `https://cyder.oregonstate.edu/search/?search=${sccmAsset['NetworkAdapter0-MACAddress']}`
          }]
        };

        // Set owner and owning department if applicable
        let username = sccmAsset['Primary-Username'] || '';
        if (username && username.startsWith('onid\\')) {
          username = username.match(/onid\\(.*$)/i)[1];
          let userEmail = `${username}@oregonstate.edu`;

          let user = tdUsers.find(e => e['PrimaryEmail'] == userEmail || e['AlertEmail'] == userEmail);
          let hasDepartment = user && user['DefaultAccountName'] && user['DefaultAccountName'] !== 'None';
          let isStudent = user && user['DefaultAccountName'] && user['DefaultAccountName'].toLowerCase().includes('major');

          if (user && user['UID'] && hasDepartment && !isStudent) {
            newAsset['OwningCustomerID'] = user['UID'];
            newAsset['OwningDepartmentID'] = user['DefaultAccountID'];
          }
        }


        // Add vendor info
        let vendor = tdVendors.find(item => item['Name'] == sccmAsset['ComputerSystem-Manufacturer']);
        if (vendor) {
          newAsset['SupplierID'] = vendor['ID'];
        }

        // Add model info
        let model = tdModels.find(item => item.Name == sccmAsset['ComputerSystem-Model']);
        if (model) {
          newAsset['ProductModelID'] = model['ID'];
        }

        if (newAsset) {
          let createdAsset = await delay(createAsset, newAsset);
          if (createdAsset && createdAsset['ID']) {
            // Add CN Label field to new asset and update
            // Note: Requires an extra API call after initial creation - needs ID from creation to create link
            let printCNLabel = createdAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.printCNLabel);
            if (!printCNLabel) {
              createdAsset['Attributes'].push({ID: ATTRIBUTES.printCNLabel, Value: `https://tools.is.oregonstate.edu/td-asset-labels/${createdAsset['ID']}`});
              await updateAsset(createdAsset);
              console.log(`Asset #${createdAsset.ID} created.`)
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

      // Find matching SCCM asset for existing TD asset
      let sccmAsset = sccmAssets.find(item => item['ResourceID'] == tdAsset['ExternalID']);

      // If no record in SCCM, deactivate asset in TD
      if (!sccmAsset) {
        if (tdAsset['StatusName'] !== 'Retired') {
          let fullTDAsset = await td.getAsset(tdAsset['AssetID']);
          fullTDAsset['StatusID'] = ATTRIBUTES.status.inactive;
          let updatedAsset = await delay(updateAsset, fullTDAsset);
          if (updatedAsset) {
            console.log(`Asset #${updatedAsset.ID} no longer found in SCCM - marked as inactive.`);
          }
        }
        continue;
      }

      if (sccmAsset && tdAsset['StatusName'] == 'Retired') {
        let fullTDAsset = await td.getAsset(tdAsset['AssetID']);
        fullTDAsset['StatusID'] = ATTRIBUTES.status.active;
        let updatedAsset = await delay(updateAsset, fullTDAsset);
        if (updatedAsset) {
          console.log(`Asset #${updatedAsset['ID']} found in SCCM but inactive in TD - marked as active.`);
        }
        continue;
      }

      // Check if SCCM-tracked asset marked active
      let isMarkedActive = tdAsset['StatusName'] == 'In Use' ||
                           tdAsset['StatusName'] == 'Loaner - Checked Out' ||
                           tdAsset['StatusName'] == 'Loaner - Available' ||
                           tdAsset['StatusName'] == 'Loaner - Unavailable';

      // Check if TD hostname matches SCCM hostname
      let sccmAssetName = sccmAsset['Name'] ? sccmAsset['Name'] : sccmAsset['Netbios_Name'] ? sccmAsset['Netbios_Name'] : '';
      let nameMatches = tdAsset['Name'] == sccmAssetName;

      // Check if vendor info matches
      let vendorMatches = true;
      let vendor = tdVendors.find(item => item['Name'] == sccmAsset['ComputerSystem-Manufacturer']);
      if (vendor) {
        vendorMatches = tdAsset['ManufacturerName'].toLowerCase() == sccmAsset['ComputerSystem-Manufacturer'].toLowerCase();
      }

      // Check if model info matches
      let modelMatches = true;
      let model = tdModels.find(item => item['Name'] == sccmAsset['ComputerSystem-Model']);
      if (model) {
        modelMatches = tdAsset['ProductModelName'].toLowerCase() == sccmAsset['ComputerSystem-Model'].toLowerCase();
      }

      // Check if CPU info matches
      let cpuMatches = true;
      if (sccmAsset['CPU-Name']) {
        cpuMatches = tdAsset[ATTRIBUTES.cpu] && tdAsset[ATTRIBUTES.cpu] == sccmAsset['CPU-Name'].trim();
      }

      // Check if memory info matches
      let memoryMatches = true;
      if (sccmAsset['Memory-Installed']) {
        memoryMatches = tdAsset[ATTRIBUTES.ram] && tdAsset[ATTRIBUTES.ram] == sccmAsset['Memory-Installed'];
      }

      // Check if AD OU matches
      let ouMatches = tdAsset[ATTRIBUTES.activeDirectoryOU] && tdAsset[ATTRIBUTES.activeDirectoryOU] == sccmAsset['OU_Name'];

      // Check if Cyder link populated
      let cyderLink = tdAsset[ATTRIBUTES.cyder] ? true : false;

      // Check if primary user and owning customer match
      let primaryUserMatches = true;
      let owningCustomerMatches = true;
      let username = sccmAsset['Primary-Username'];
      let userEmail = '';
      if (username && username.match(/onid\\(.*$)/i)) {
        let usrname = sccmAsset['Primary-Username'].match(/onid\\(.*$)/i)[1];
        userEmail = `${usrname}@oregonstate.edu`;
      }
      let user;
      if (userEmail) {
        user = tdUsers.find(e => e['PrimaryEmail'] == userEmail || e['AlertEmail'] == userEmail);
      }

      if (username && user) {
        let hasDepartment = user && user['DefaultAccountName'] && user['DefaultAccountName'] !== 'None';
        let isStudent = user && user['DefaultAccountName'] && user['DefaultAccountName'].toLowerCase().includes('major');
        primaryUserMatches = tdAsset[ATTRIBUTES.primaryuser] && tdAsset[ATTRIBUTES.primaryuser] == sccmAsset['Primary-Username'];

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
        !ouMatches ||
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
        ouMatches:             ${ouMatches}
        cyderLink:             ${cyderLink}
        primaryUserMatches:    ${primaryUserMatches}
        owningCustomerMatches: ${owningCustomerMatches}
        `)
        let fullTDAsset = await td.getAsset(tdAsset['AssetID']);

        if (!isMarkedActive) {
          fullTDAsset['StatusID'] = ATTRIBUTES.status.active;
        }

        if (!nameMatches) {
          fullTDAsset['Name'] = sccmAssetName;
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
          fullTDAsset['Attributes'][targetAttr].Value = sccmAsset['CPU-Name'].trim();
        }

        if (!memoryMatches) {
          let attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.ram);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.ram, Value: ''});
            attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.ram);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = sccmAsset['Memory-Installed'];
        }

        if (!ouMatches) {
          let attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.activeDirectoryOU);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.activeDirectoryOU, Value: ''});
            attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.activeDirectoryOU);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = sccmAsset['OU_Name'];
        }

        if (!cyderLink) {
          let attr = fullTDAsset['Attributes'].find(e=> e['ID'] == ATTRIBUTES.cyder);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.cyder, Value: ''});
            attr = fullTDAsset['Attributes'].find(e=> e['ID'] == ATTRIBUTES.cyder);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = `https://cyder.oregonstate.edu/search/?search=${sccmAsset['NetworkAdapter0-MACAddress']}`;
        }

        if (!primaryUserMatches) {
          let attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.primaryuser);
          if (!attr) {
            fullTDAsset['Attributes'].push({ID: ATTRIBUTES.primaryuser, Value: ''});
            attr = fullTDAsset['Attributes'].find(e => e['ID'] == ATTRIBUTES.primaryuser);
          }
          let targetAttr = fullTDAsset['Attributes'].indexOf(attr);
          fullTDAsset['Attributes'][targetAttr].Value = sccmAsset['Primary-Username'];
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

syncAssets();

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
