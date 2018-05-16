'use strict';

const AWS = require('aws-sdk');
const dynamoDb = new AWS.DynamoDB.DocumentClient();
const DRIPBOT_TABLE = process.env.DRIPBOT_TABLE;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const HIGH_BS = 225;
const HIGH_BS_WAIT = 60; // in minutes
const LOW_BS = 70;
const LOW_BS_WAIT = 30;  // in minutes
const MAX_DATA_AGE = 20; // max age in minutes before a warning flag appears on the view page

const arrowList = {
  'DoubleUp': '⟰',
  'SingleUp': '⇑',
  'FortyFiveUp': '⇗',
  'Flat': '⇒',
  'FortyFiveDown': '⇘',
  'SingleDown': '⇓',
  'DoubleDown': '⟱',
}

const arrowListHTML = {
  'DoubleUp': '&uarr;&uarr;',
  'SingleUp': '&uarr;',
  'FortyFiveUp': '&nearr;',
  'Flat': '&rarr;',
  'FortyFiveDown': '&searr;',
  'SingleDown': '&darr;',
  'DoubleDown': '&darr;&darr;',
}


module.exports.logEvent = (event, context, callback) => {
  //console.log('Received event from xDrip+: ', JSON.stringify(event, null, 2));

  var body = "";

  switch(event.httpMethod) {
    case "POST":
      if (event.pathParameters && event.pathParameters.username && event.pathParameters.action == "entries" && event.body) {
        // read body
        // "{\"device\":\"xDrip-LimiTTer\",\"date\":1526317585929,\"dateString\":\"2018-05-14T12:06:25.929-0500\",\"sgv\":136,\"direction\":\"Flat\"}"
        var input = JSON.parse(event.body);
        console.log(input);

        handleEntries(event.pathParameters.username, input, callback);
      }

      if (event.pathParameters && event.pathParameters.action == "devicestatus" && event.body) {
        // read body
        // "{\"device\":\"LimiTTer\",\"uploader\":{\"battery\":100}}"
        var input = JSON.parse(event.body);
        //console.log(input);

        handleDeviceStatus(event.pathParameters.username, input, callback);
      }
      break;

    case "GET":
      // show latest reading
        getUserRecord(event.pathParameters.username)
        .then((user) => {
          var viewData = {
            BloodSugarLevel: user.sgv,
            Direction: user.direction,
            LastTested: user.testTime,
          } 
          console.log(`Serving GET response for user ${event.pathParameters.username}`);

          var output = `<html><head><title>${user.userName} at ${user.sgv} ${arrowListHTML[user.direction]}</title><body>\n`;
          output += `<script>setTimeout(function() { location.reload(true) }, 120000);</script>`;
          output += `<style> .row:after {content: ""; display: table; clear: both;} .leftcol {float: left; width: 130px} .rightcol { float: left; width: 220px}</style>`;

          for(var label in viewData) {
            output += `<div class="row"><div class="leftcol">${label}</div><div class="rightcol">${viewData[label]}</div></div>\n`;
          }
          var testTime = Date.parse(user.testTime);
          if (Date.now() - testTime > MAX_DATA_AGE * 60 * 1000) {
            output += `<div style="color: red; border: 1px solid black">Sample data is more than ${MAX_DATA_AGE} minutes old</div>`;
          }
          output += '</body>';
          // send output
          callback(null, {
            statusCode: 200,
            headers: {
              'Content-Type': 'text/html',
              'Access-Control-Allow-Origin': '*', // Required for CORS support to work
            },
            body: output,
          });
        })
        .catch((error) => {
          console.log('an eroror occurred: ', error);
        });
      body = "todo: lookup user's latest reading and display it";
  }

  const response = {
    statusCode: 200,
    headers: {
      'Access-Control-Allow-Origin': '*', // Required for CORS support to work
    },
    body: body,
  };

  //callback(null, response);
};


function handleEntries(username, input, callback) {
  getUserRecord(username)
  .then((user) => {
    if (user) {
      user.sgv = input.sgv;
      user.direction = input.direction;
      user.testTime = input.dateString;
      user.high_bs = user.high_bs ? user.high_bs : HIGH_BS;
      user.high_bs_wait = user.high_bs_wait ? user.high_bs_wait : HIGH_BS_WAIT;
      user.low_bs = user.low_bs ? user.low_bs : LOW_BS;
      user.low_bs_wait = user.low_bs_wait ? user.low_bs_wait : LOW_BS_WAIT;

      var arrow = arrowList[input.direction];
      arrow = arrow ? arrow : '';

      if (user.email && input.sgv > user.high_bs) {
        if (user.lastHighBSNotification + (user.high_bs_wait * 60 * 1000) < Date.now()) {
          // send high bs notification
          var msg = `HIGH BS: ${input.sgv} ${arrow} ${input.direction} ${input.dateString}.\nUser considers ${user.high_bs} to be high.\nNext msg in ${user.high_bs_wait} minutes.`;
          // TODO: send sms
          sendEmail('high bs', msg, user.email);
          // log timestamp of high bs notification
          user.lastHighBSNotification = Date.now();
        } else {
          console.log(`Deferring High BS notification due to timeout. (last notification at ${new Date(user.lastHighBSNotification)}`);
        }
      }
      if (user.email && input.sgv < user.low_bs) {
        user.lastLowBSNotification = user.lastLowBSNotification ? user.lastLowBSNotification : 0;
        if (user.lastLowBSNotification + (user.low_bs_wait * 60 * 1000) < Date.now()) {
          // send low bs notification
          var msg = `LOW BS: ${input.sgv} ${arrow} ${input.direction} ${input.dateString}.\nUser considers ${user.low_bs} to be low.\nNext msg in ${user.low_bs_wait} minutes.`;
          // TODO: send sms
          sendEmail('low bs', msg, user.email);
          // log timestamp of low bs notification
          user.lastLowBSNotification = Date.now();
        } else {
          console.log(`Deferring Low BS notification due to timeout. (last notification at ${new Date(user.lastLowBSNotification)}`);
        }
      }
      return updateUserRecord(user);
    }
  })
  .then(() => {
    // send output
    callback(null, {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Required for CORS support to work
      },
      body: 'success',
    });
  })
  .catch((error) => {
    console.log('an eroror occurred: ', error);
  });
}


function handleDeviceStatus(username, input, callback) {
  getUserRecord(username)
  .then((user) => {
    if (user) {
      if (!user.devices) {
        user.devices = {};
      }
      user.devices[input.device] = input.uploader;
      return updateUserRecord(user);
    }
  })
  .then(() => {
    // send output
    callback(null, {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*', // Required for CORS support to work
      },
      body: 'success',
    });
  })
  .catch((error) => {
    console.log('an eroror occurred: ', error);
  });
}


/**
 * Looks up an DRIPBOT_TABLE record using username and returns a Promise.
 */
function getUserRecord(username) {
  // get the active record
  return new Promise((resolve, reject) => {
    // lookup active user record with username in database
    const params = {
      TableName: DRIPBOT_TABLE,
      Key: {
        userName: username,
      }
    };
    dynamoDb.get(params, (error, result) => {
      if (error) {
        console.log(error);
        reject("DB Query error: ", error);
      }
      var item = result.Item;

      if (!item) {
        // create a new user if one does not exist
        item = {
          userName: username,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }

        const updateParams = {
          TableName: DRIPBOT_TABLE,
          Item: item,
        };

        dynamoDb.put(updateParams, (error) => {
          if (error) {
            console.log(error);
            reject("DB Query error: ", error);
          }
          resolve(item);
        });

      } else {
        resolve(item);
      }
    });
  });
}

/**
 * Looks up an DRIPBOT_TABLE record using username and returns a Promise.
 */
function updateUserRecord(user) {

  user.updatedAt = Date.now();
  const updateParams = {
      TableName: DRIPBOT_TABLE,
      Item: user,
  };

  return dynamoDb.put(updateParams, (error) => {
    if (error) {
      console.log(error);
    }
  });
}

function sendEmail(subjectText, bodyText, toAddresses) {
  console.log(`sending email with subject ${subjectText}, body ${bodyText}, toAddresses ${toAddresses}`);

  if (!Array.isArray(toAddresses)) {
    toAddresses = [toAddresses];
  }
  /* The following example sends a formatted email: */
  //AWS.config.region = 'us-east-1';
  var ses = new AWS.SES();
  var params = {
    Destination: {
     ToAddresses: toAddresses
    }, 
    Message: {
      Body: {
        Text: {
          Charset: "UTF-8", 
          Data: bodyText
        }
      },
      Subject: {
        Charset: "UTF-8", 
        Data: subjectText
      }
    },  
    Source: SENDER_EMAIL,
     Tags: [
       {
         Name: 'source', /* required */
         Value: 'AWS' /* required */
       },
       /* more items */
     ]
   };
 
  ses.sendEmail(params, function(err, data) {
    if (err) {
      console.log(err, err.stack); // an error occurred
    } else {
      console.log("Sent email");           // successful response
    }
  })
}
