
var AWS                 = require('aws-sdk');
var guid                = require('guid');
var https               = require('https');
var doc                 = require('dynamodb-doc');
var SqsQueueParallel    = require('sqs-queue-parallel');
var _                   = require('underscore');

function Sasquatcha(parameters)
{
    this.options = {
        logger: function(message, detail, level){ console.log(level.toUpperCase()+': '+message, detail); },
        useLegacyDynamo: false,
        tableName: 'SasquatchaWatcha',
        maxNumberOfMessages: 1,
        concurrency: 1,
        autoConfirmSubscriptions: false
    };

    this.options = _.extend(this.options,parameters);
    this.queueOptions = this.getQueueOptions();
    this.watchedQueues = {};

    var self = this,
        params = {
            TableName: this.getDbTableName()
        };

    this.dynamo = this.getDynamo();
    this.dynamo.describeTable(params, function(err, data) {
        if (err){
            self.log(err, err.stack, 'error');
            self.makeTable();
            self.dynamo.waitFor('tableExists', params, function(err, data) {
                if (err)
                {
                    self.log(err, err.stack, 'error');
                }
                else
                {
                    self.log(data);
                }
            });
        }
        else {
            self.log('Tasks: '+params.TableName+' exists.', null, 'info');
        }
    });

}

Sasquatcha.prototype.start = function(callback)
{
    // TODO; allow first parameter to be a string of an SQS name and only start for that queue
    var self = this;
    this.getWatchableQueues(function(err, data) {
        if (err)
        {
            self.log(err,null,'error');
        }
        else
        {
            if (!data.Items || !data.Items.length) return;
            _.each(data.Items,function(queueData){
                self.watchQueue(queueData, callback);
            });
        }
    });
};

Sasquatcha.prototype.getWatchableQueues = function(callback)
{
    this.getQueues({
        IndexName: 'enabled-index',
        KeyConditions: [
            this.dynamo.Condition("enabled", "EQ", 1)
        ]
    },callback);
};

Sasquatcha.prototype.autoConfirmSubscription = function(sqsMessage,callback)
{
    try
    {
        // http://docs.aws.amazon.com/sns/latest/dg/SendMessageToSQS.cross.account.html
        if (typeof sqsMessage.SubscribeURL === "string" && sqsMessage.SubscribeURL.length)
        {
            https.get(sqsMessage.SubscribeURL, function(res){
                res.on('data', function(data){
                    self.log("Response from Automatic Confirmation of Subscription", data, 'warn');
                    callback && callback(null,data);
                    callback = null;
                });
            }).on('error', function(e) {
                callback && callback(e, null);
            });
        }

    }
    catch (e)
    {
        callback("Unable to confirm subscription " + event.message.MessageId, '');
    }
};

Sasquatcha.prototype.watchQueue = function (queueData,callback)
{

    var self = this;
    var queueWatchOptions = _.extend(this.queueOptions,{ name: queueData.sqsName });

    this.watchedQueues[queueData.sqsName] = this.getSQSQueue(queueWatchOptions);
    var queue = this.watchedQueues[queueData.sqsName];

    queue.on('message', function(event) {
        try
        {

            self.log("Received SQS message "+event.message.MessageId, event.data, 'info');
            event.changeMessageVisibility(30, function(err,data){

                if (!err)
                {

                    if (self.isConfirmationMessage(event.message) && self.isAutoConfirmQueue(queueData))
                    {
                        queueData.autoConfirmPending = true;
                        self.autoConfirmSubscription(event.message,function(err, data){
                            if (err) {
                                self.log("Error Confirming Subscription " + event.message.MessageId, data, 'error');
                            }
                            else {
                                self.log("Subscription Confirmed " + event.message.MessageId, data, 'info');
                            }
                        });
                    }

                    callback(null, queueData, event, function(err){
                        if (!err)
                        {
                            event.deleteMessage(function (err, data) {
                                if (err) {
                                    self.log("Error Deleting Message " + event.message.MessageId, data, 'error');
                                }
                                else {
                                    self.log("Deleted Message " + event.message.MessageId, data, 'info');
                                }
                                event.next();
                            });
                        }
                        else
                        {
                            event.next();
                        }
                    });
                }
                else
                {
                    self.log(err, event.data, 'error');
                    callback(err, null, event, event.next);
                }

            });

        }
        catch (ex)
        {
            self.log("Error Occurred processing SQS Message " + event.message.MessageId, { ex: ex, evt: event }, 'error');
            callback(errMsg, null, event, event.next);
        }
    });

    queue.on('error', function (err) {
        self.log(err, null, 'error');
    });

};

Sasquatcha.prototype.getSQSQueue = function (queueWatchOptions)
{
    return new SqsQueueParallel(queueWatchOptions);
};

Sasquatcha.prototype.unwatch = function (queueDetails)
{
    this.watchedQueues[queueData.name] = queue;
};

Sasquatcha.prototype.isAutoConfirmQueue = function (queueDetails)
{
    return queueDetails.autoConfirm == true || this.options.autoConfirmSubscriptions == true;
};

Sasquatcha.prototype.isConfirmationMessage = function (message)
{
    return (typeof message.SubscribeURL  === "string");
};

Sasquatcha.prototype.getQueues = function (queryOptions, callback)
{
    if (!queryOptions.KeyConditions || !queryOptions.IndexName)
    {
        callback('KeyConditions and IndexName are Required',null);
    }

    queryOptions.TableName = this.getDbTableName();

    this.dynamo.query(queryOptions,function(err, data) {
        callback(err, data);
    });
};

Sasquatcha.prototype.addWatch = function(queueName, queueData, enabled, callback)
{

    queueData = queueData || {};
    enabled = enabled ? 1 : 0;

    var self = this,
        dynamo = this.getDynamo(),
        itemRecord = _.extend(queueData,{
            id: guid.create().value,
            sqsName: queueName,
            enabled: enabled,
            autoConfirm: false
        });

    if (typeof itemRecord.sqsName !== "string" || !itemRecord.sqsName.length)
    {
        callback('sqsName is not a string or null',null);
    }
    else
    {
        dynamo.putItem({
                TableName: this.getDbTableName(),
                Item: itemRecord
            },
            function(err,data){
                var newId = itemRecord.id;
                var errorMessage = '';
                if (err)
                {
                    errorMessage = err.message;
                    self.log('Error adding a queue', err, 'error');
                }
                else
                {
                    self.log('Added queue to watch successfully', null, 'info');
                }
                callback(errorMessage,newId);
            });
    }

};

Sasquatcha.prototype.getDbTableName = function() {
    return this.options.tableName;
};


Sasquatcha.prototype.getDynamo = function() {

    if(typeof this.dynamo === 'undefined')
    {
        var dynamoConfig = {
            endpoint: process.env.DYNAMO_ENDPOINT,
            accessKeyId: process.env.AWS_ACCESS_KEY,
            secretAccessKey: process.env.AWS_SECRET_KEY,
            region: process.env.AWS_REGION
        };
        // this breaks the tests and isn't needed anyway
        if (!this.options.useLegacyDynamo)
        {
            // work around for [NetworkingError: write EPROTO] https://github.com/aws/aws-sdk-js/issues/862
            dynamoConfig.httpOptions = {
                agent: new https.Agent({
                    rejectUnauthorized: true,
                    secureProtocol: "TLSv1_method", // workaround part ii.
                    ciphers: "ALL"                  // workaround part ii.
                })
            };
        }
        var dynamo = new AWS.DynamoDB(dynamoConfig);
        this.dynamo = new doc.DynamoDB(dynamo);
    }

    return this.dynamo;
};

Sasquatcha.prototype.makeTable = function()
{

    var dynamo = this.getDynamo(),
        params = {
            TableName: this.getDbTableName(),
            AttributeDefinitions: [
                {AttributeName: 'id',           AttributeType: 'S'},
                {AttributeName: 'sqsName',      AttributeType: 'S'},
                {AttributeName: 'enabled',      AttributeType: 'N'},
                {AttributeName: 'autoConfirm',  AttributeType: 'N'}
            ],
            KeySchema: [
                { AttributeName: 'id',    KeyType: 'HASH' }
            ],
            ProvisionedThroughput: {
                ReadCapacityUnits: 5,
                WriteCapacityUnits: 5
            },
            GlobalSecondaryIndexes: [
                {
                    IndexName: 'enabled-index',
                    KeySchema: [
                        {AttributeName: 'enabled',   KeyType: 'HASH'}
                    ],
                    Projection: {
                        ProjectionType:'ALL'
                    },
                    ProvisionedThroughput: {
                        ReadCapacityUnits: 5,
                        WriteCapacityUnits: 2
                    }
                },
                {
                    IndexName: 'sqsName-index',
                    KeySchema: [
                        {AttributeName: 'sqsName',   KeyType: 'HASH'}
                    ],
                    Projection: {
                        ProjectionType:'ALL'
                    },
                    ProvisionedThroughput: {
                        ReadCapacityUnits: 3,
                        WriteCapacityUnits: 2
                    }
                }
            ]
        };

    dynamo.createTable(params, function(err, data) {
        if (err)
        {
            console.error(err);
        }
        else
        {
            console.log('Made Table:'+data);
        }
    });

};

Sasquatcha.prototype.getQueueOptions = function(defaults)
{
    var queOpts = _.extend({},defaults,this.options);
    delete queOpts.useLegacyDynamo;
    delete queOpts.tableName;
    delete queOpts.logger;
    return queOpts;
};

Sasquatcha.prototype.log = function(message, detail, level)
{
    this.options.logger(message, detail, level);
};

module.exports = Sasquatcha;