'use strict';

let BbPromise = require('bluebird'),
    AWS = require('aws-sdk'),
    chalk = require('chalk'),
    readline = require('readline'),
    Spinner = require('cli-spinner').Spinner;

module.exports = CFNRunner;

function CFNRunner(templatePath, config) {

    this.cfnConfig = require('cfn-config');

    this.msgPrefix = function() {
        readline.clearLine(process.stdout, 0);
        readline.cursorTo(process.stdout, 0);
        return '  | ';
    };

    this.options = {
        "region": config.region,
        "template": templatePath,
        "name": config.name,
        "update": false,
        "config": "./awsConfig.json",
        "defaults": config.defaults
    };
    var pathTokens = templatePath.split("/");
    this.options.name = pathTokens[pathTokens.length - 1].split(".")[0];

    this.awsConfig = {"region": config.region, "accessKeyId": config.accessKeyId, "secretAccessKey": config.secretAccessKey};

    this.cfnConfig.setCredentials(this.awsConfig.accessKeyId, this.awsConfig.secretAccessKey);

    this.CloudFormation = BbPromise.promisifyAll(new AWS.CloudFormation(this.awsConfig), {
        suffix: "Promised"
    });

    this.spinner = new Spinner('  ' + chalk.yellow('%s '));
}

CFNRunner.prototype.monitorStack = function(options, stackAction, cb) {

    this.spinner.setSpinnerDelay(60);
    this.spinner.start();
    require('chalk');
    var colors = {
        "CREATE_IN_PROGRESS": chalk.yellow,
        "CREATE_FAILED": chalk.red,
        "CREATE_COMPLETE": chalk.green,
        "DELETE_IN_PROGRESS": chalk.yellow,
        "DELETE_FAILED": chalk.red,
        "DELETE_COMPLETE": chalk.gray,
        "DELETE_SKIPPED": chalk.gray,
        "UPDATE_IN_PROGRESS": chalk.yellow,
        "UPDATE_COMPLETE_CLEANUP_IN_PROGRESS": chalk.yellow,
        "UPDATE_FAILED": chalk.red,
        "UPDATE_COMPLETE": chalk.green,
        "ROLLBACK_IN_PROGRESS": chalk.red,
        "ROLLBACK_COMPLETE": chalk.red
    };

    var cfn = new AWS.CloudFormation(this.awsConfig);

    var EventStream = require('cfn-stack-event-stream');

    var _this = this;

    EventStream(cfn, options.name, {
            pollInterval: 4000
        })
        .on('error', function(e) {
            if (stackAction === "DELETE" && e.message.indexOf("does not exist") !== -1) {
                console.log(_this.msgPrefix() + "Deletion complete.");
                _this.spinner.stop();
                return cb();
            } else {
                _this.spinner.stop();
                return cb(e);
            }
        })
        .on('data', function(e) {
            console.log(
                _this.msgPrefix() +
                colors[e.ResourceStatus](e.ResourceStatus) + ' ' +
                e.LogicalResourceId +
                (e.ResourceStatusReason ? '  - ' + e.ResourceStatusReason : '')
            );
        })
        .on('end', function() {
            console.log(_this.msgPrefix() + "Starting cleanup...");
            //If the stack fails on creation then it should be deleted
            if (stackAction === "CREATE") {
                cfn.describeStacks({
                    "StackName": options.name
                }, function(err, data) {
                    if (err) {
                        console.log(_this.msgPrefix + "Error getting stack info for cleanup: " + err.cause.message);
                        _this.spinner.stop();
                        cb(err);
                    } else {
                        if (data.Stacks.length === 1) {

                            if (data.Stacks[0].StackStatus === "ROLLBACK_COMPLETE") {
                                _this.deleteStack(cb);
                            } else {
                                _this.spinner.stop();
                                cb();
                            }

                        } else {
                            console.log(_this.msgPrefix + "Stack could not be uniquely identified.  Skipping cleanup...");
                            _this.spinner.stop();
                            cb();
                        }
                    }

                });
            } else {
                _this.spinner.stop();
                cb();
            }

        });
};


CFNRunner.prototype.createStack = function(cb) {
    console.log(this.msgPrefix() + "Creating the stack...");
    var _this = this;
    this.cfnConfig.createStack(this.options, function(err) {
        if (err) {
            console.log(err);
            cb(err);
        } else {
            _this.monitorStack(_this.options, "CREATE", function(err) {

                //delete any orphan buckets related to this stack, if they're empty
                _this.deleteBuckets(_this.options.name);
                cb(err);

            });
        }
    });
};

CFNRunner.prototype.updateStack = function(cb) {
    console.log(this.msgPrefix() + "Updating the stack...");
    var _this = this;
    this.cfnConfig.updateStack(this.options, function(err) {
        if (err) {
            console.log(err);
            cb(err);
        } else {
            _this.monitorStack(_this.options, "UPDATE", cb);
        }
    });
};

CFNRunner.prototype.deleteStack = function(cb) {
    console.log(this.msgPrefix() + "Deleting the stack...");
    var _this = this;
    this.cfnConfig.deleteStack(this.options, function(err) {
        if (err) {
            console.log(err);
            cb(err);
        } else {
            _this.monitorStack(_this.options, "DELETE", cb);
        }
    });
};

CFNRunner.prototype.deleteBuckets = function(stackName) {
    var _this = this;
    var S3 = BbPromise.promisifyAll(new AWS.S3(this.awsConfig), {
        suffix: "Promised"
    });
    S3.listBucketsPromised()
        .then(function(data) {
            data.Buckets.forEach(function(el) {
                if (el.Name.toLowerCase().indexOf(stackName.toLowerCase()) !== -1) {
                    var params = {
                        Bucket: el.Name
                    };
                    S3.listObjectsPromised(params)
                        .then(function(data) {
                            if (data.Contents.length === 0) {
                                S3.deleteBucketPromised(params)
                                    .then(function() {
                                        console.log(_this.msgPrefix() + "Ophan buckets deleted.");
                                    })
                                    .catch(function(e) {
                                        console.log(_this.msgPrefix() + "Error deleting orphan bucket: " + e.cause.message);

                                    });
                            }
                        });
                }
            });
        })
        .catch(function(e) {
            console.log(this.msgPrefix() + "Error listing buckets: " + e.cause.message);
        });

};

CFNRunner.prototype.deployStack = function(cb) {
    let _this = this;

    // Helper function to create Stack
    let createStack = function() {
        _this.createStack(function(err) {
            if (err) {
                console.error(err);
                return cb(err);
            } else {
                cb();
            }
        });
    };

    // Check to see if Stack Exists
    return _this.CloudFormation.describeStackResourcesPromised({
            StackName: _this.options.name
        })
        .then(function() {
            // Update stack
            _this.updateStack(function(err) {
                if (err) {
                    if (err.message === 'No updates are to be performed.') {
                        console.log(_this.msgPrefix() + 'No resource updates are to be performed.');
                        cb();
                    } else {
                        console.error(err);
                        return cb(err);
                    }
                } else {
                    cb();
                }
            });
        })
        .catch(function(e) {
            // If does not exist, create stack
            if (e.cause.message.indexOf('does not exist') > -1) {
                return createStack();
            } else {
                console.error(e);
                return cb(e);
            }
        });
};
