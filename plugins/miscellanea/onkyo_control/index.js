'use strict';

const libQ = require('kew');
const fs = require('fs-extra');
//let config = new (require('v-conf'))();
//let exec = require('child_process').exec;

const io = require('socket.io-client');
const socket = io.connect('http://localhost:3000');
const eiscp = require('eiscp');

module.exports = onkyoControl;

function onkyoControl(context) {
    const self = this;

    self.context = context;
    self.commandRouter = self.context.coreCommand;
    self.logger = self.context.logger;
    self.configManager = self.context.configManager;

    self.zoneList = [];
    self.receivers = {};
    self.connectionOptions = {
        reconnect: true,
        verify_commands: false
    };
    self.musicState = 'stopped';
    self.receiverState = 'off';
    self.volume = 0;
}

onkyoControl.prototype.onVolumioStart = function () {
    const self = this;
    const configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
    this.config = new (require('v-conf'))();
    self.logger.debug("ONKYO-CONTROL:  CONFIG FILE: " + configFile);
    this.config.loadFile(configFile);

    self.load18nStrings();

    return libQ.resolve();
}

onkyoControl.prototype.onStart = function () {
    const self = this;
    const defer = libQ.defer();

    // Discover what receivers are available
    eiscp.discover({timeout: 5}, function (err, results) {
        if (err) {
            self.logger.error("ONKYO-CONTROL: Error discovering receivers: " + results);
        }
        else {
            self.logger.debug("ONKYO-CONTROL: Found these receivers on the local network: " + JSON.stringify(results));
            results.forEach(function (receiver) {
                self.receivers[receiver.mac] = {
                    "host": receiver.host,
                    "model": receiver.model,
                    "mac": receiver.mac,
                    "port": receiver.port
                };
            });

            const firstReceiver = Object.values(self.receivers)[0];

            if (self.config.get('autoDiscovery')) {
                self.connectionOptions.port = firstReceiver.port;
                self.connectionOptions.host = firstReceiver.host;
                self.connectionOptions.model = firstReceiver.model;
            }
            else {
                self.connectionOptions.port = self.config.get('receiverPort', firstReceiver.port);
                self.connectionOptions.host = self.config.get('receiverIP', firstReceiver.host);
                self.connectionOptions.model = self.config.get('receiverModel', firstReceiver.model);
            }

            // Figure out the available zones
            const modelCommands = eiscp.get_model_commands(self.connectionOptions.model);
            Object.keys(modelCommands).forEach(zone => {
                self.zoneList.push(zone);
            });

            // Now that we have our connection options completed, let's connect.
            // We will want to disconnect and reconnect if the receiver option changes.
            eiscp.connect(self.connectionOptions);

            // Fire off a message to get an initial state back from the backend.
            socket.emit("getState");

            // Since this is a callback and the rest of the on start is synchronous,
            // consider this the end of the start function.
            self.logger.info("ONKYO-CONTROL: *********** ONKYO PLUGIN STARTED ********");
            defer.resolve();
        }
    });

    eiscp.on('error', function (error) {
        self.logger.error("ONKYO-CONTROL:  An error occurred trying to comminicate with the receiver: " + error);
    });

    socket.on('pushState', function (state) {

        self.logger.debug("ONKYO-CONTROL: *********** ONKYO PLUGIN STATE CHANGE ********");
        self.logger.info("ONKYO-CONTROL: New state: " + JSON.stringify(state) + " connection: " + JSON.stringify(self.connectionOptions));

        let waitToSend = 0;
        if (!eiscp.is_connected) {
            eiscp.connect(self.connectionOptions);
            waitToSend = 500;
        }
        
        if (state.status !== self.musicState) {

            self.musicState = state.status;

            switch (self.musicState) {
                case 'play':
                    // We only want to turn things on if music is playing and
                    // the reveiver has yet to be turned on.
                    if (self.receiverState === 'off') {
                        if (self.config.get('powerOn')) {

                            self.callReceiver({
                                "action": 'power',
                                "value": 'on',
                                "waitToSend": waitToSend,
                            });
                        }

                        if (self.config.get('setVolume')) {

                            const volume = self.config.get('setVolumeValue', self.config.get('maxVolume', 100));
                            self.volume = volume;

                            // Let's tell the backend what the volume should be
                            // as well so that we can stay in sync. Typically
                            // after this first set, we shouldn't need to set
                            // it again.
                            socket.emit("volume", self.volume);

                            self.callReceiver({
                                "action": 'volume',
                                "value": self.volume,
                                "waitToSend": waitToSend,
                            });
                        }

                        if (self.config.get('setInput')) {

                            self.callReceiver({
                                "action": 'selector',
                                "value": self.config.get('setInputValue'),
                                "waitToSend": waitToSend,
                            });
                        }

                        self.receiverState = 'on';
                    }

                    break;
                case 'stop':
                case 'pause':

                    if (self.config.get('standby', true)) {

                        if (self.receiverState === 'on') {
                            setTimeout(() => {

                                // Every time we pause or stop music, we will
                                // call into the function based on our turn off
                                // delay setting. This will stop us from
                                // accidentally turning the system off if we
                                // are still using it.
                                if (self.musicState !== 'play' && self.receiverState === 'on') {
                                    // Update our receiver state so that if we
                                    // do start playing music again, we can
                                    // turn things back on.
                                    self.receiverState = 'off';
                                    self.callReceiver({
                                        "action": 'power',
                                        "value": 'standby',
                                        "waitToSend": waitToSend,
                                    });
                                }
                            }, self.config.get('standbyDelay') * 1000);
                        }
                    }

                    break;
                default:
                    break;
            }
        }
        else {
            // Throwing this in an else so that we don't accidentally
            // overwrite the initial play volume.
            if (self.receiverState === 'on' && self.volume !== state.volume) {

                const maxVolume = self.config.get('maxVolume', 100);
                self.volume = (state.volume) > maxVolume ? maxVolume : state.volume;
                self.callReceiver({
                    "action": 'volume',
                    "value": self.volume,
                    "waitToSend": waitToSend,
                });
            }
        }
    });

    return defer.promise;
};

onkyoControl.prototype.onStop = function () {
    var self = this;
    var defer = libQ.defer();

    self.running = false;
    self.logger.info("ONKYO-CONTROL: *********** ONKYO PLUGIN STOPPED ********");

    eiscp.disconnect();

    // Once the Plugin has successfull stopped resolve the promise
    defer.resolve();

    return libQ.resolve();
};

onkyoControl.prototype.getConfigurationFiles = function () {
    return ['config.json'];
}

// Configuration Methods -----------------------------------------------------------------------------

onkyoControl.prototype.refreshUIConfig = function() {
    let self = this;
    
    self.commandRouter.getUIConfigOnPlugin('miscellanea', 'onkyo_control', {}).then( config => {
        self.commandRouter.broadcastMessage('pushUiConfig', config);
    });
}

onkyoControl.prototype.getUIConfig = function () {
    var defer = libQ.defer();
    var self = this;

    var lang_code = this.commandRouter.sharedVars.get('language_code');

    self.commandRouter.i18nJson(__dirname + '/i18n/strings_' + lang_code + '.json',
        __dirname + '/i18n/strings_en.json',
        __dirname + '/UIConfig.json')
        .then( async (uiconf) => {
            self.logger.debug("ONKYO-CONTROL: getUIConfig()");

            uiconf.sections[0].content[0].value = self.config.get('autoDiscovery', true);
            uiconf.sections[0].content[2].value = self.config.get('receiverIP');
            uiconf.sections[0].content[3].value = self.config.get('receiverPort');
            uiconf.sections[0].content[4].value = self.config.get('receiverModel');

            uiconf.sections[1].content[0].value = self.config.get('zone', 'main');
            uiconf.sections[1].content[1].value = self.config.get('powerOn', true);
            uiconf.sections[1].content[2].value = self.config.get('maxVolume', 100);
            uiconf.sections[1].content[3].value = self.config.get('setVolume', false);
            uiconf.sections[1].content[4].value = self.config.get('setVolumeValue');
            uiconf.sections[1].content[5].value = self.config.get('setInput', false);
            uiconf.sections[1].content[7].value = self.config.get('standby', true);
            uiconf.sections[1].content[8].value = self.config.get('standbyDelay');

            for (const [key, receiver] of Object.entries(self.receivers)) {

                const receiverValue = `${receiver.host}_${receiver.model}_${key}_${receiver.port}`;
                var option = {
                    "value": receiverValue,
                    "label": receiver.model + " : " + key
                };
                uiconf.sections[0].content[1].options.push(option);

                if (receiverValue === self.config.get('receiverSelect')) {
                    uiconf.sections[0].content[1].value = option;
                }
            }

            if (!uiconf.sections[0].content[1].value) {
                uiconf.sections[0].content[1].value = {
                    "value": "manual",
                    "label": self.getI18nString("SELECT_RECEIVER_MANUAL")
                };
            }

            self.zoneList.forEach(zone => {

                // Removing the "dock" zone. No clue what it is, but if
                // anyone is looking at this in the future and wants it,
                // let me know.
                if (zone !== 'dock') {
                    const option = {"value": zone, "label": zone};

                    uiconf.sections[1].content[0].options.push(option);

                    if (zone === self.config.get('zone', 'main')) {
                        uiconf.sections[1].content[0].value = option;
                    }
                }
            });

            eiscp.get_command('input-selector', function (err, results) {
                results.forEach(function (input) {
                    const option = {"value": input, "label": input};
                    uiconf.sections[1].content[6].options.push(option);

                    if (input === self.config.get('setInputValue')) {
                        uiconf.sections[1].content[6].value = option;
                    }
                });
            });

            defer.resolve(uiconf);
        })
        .fail(function () {
            defer.reject(new Error());
        });

    return defer.promise;
};

onkyoControl.prototype.saveConnectionConfig = function (data) {
    var self = this;

    self.logger.debug("ONKYO-CONTROL: saveConnectionConfig() data: " + JSON.stringify(data));
    self.config.set('autoDiscovery', data['autoDiscovery']);
    self.config.set('receiverSelect', data['receiverSelect'].value);
    const newValues = {};

    if (data['receiverSelect'].value !== "manual") {
        /*
            Split up the receiverSelect into its parts
            0: host / ip
            1: model
            2: mac
            3: port
        */ 
        const valueParts = data['receiverSelect'].value.split('_');
    
        self.config.set('receiverIP', valueParts[0]);
        self.config.set('receiverPort', valueParts[3]);
        self.config.set('receiverModel', valueParts[1]);
        newValues.host = valueParts[0];
        newValues.port = valueParts[3];
        newValues.model = valueParts[1];
    }
    else {
        self.config.set('receiverIP', data['receiverIP']);
        self.config.set('receiverModel', data['receiverModel']);
        newValues.host = data['receiverIP'];
        newValues.model = data['receiverModel'];
        
        if (!data['receiverPort'] || data['receiverPort'] === '' || isNaN(data['receiverPort'])) {
            self.config.set('receiverPort', '60128');
            newValues.port = '60128';
        }
        else {
            self.config.set('receiverPort', data['receiverPort']);
            newValues.port = data['receiverPort'];
        }
    }
    
    if (!(newValues.host --- self.connectionOptions.host)) {
        
        self.connectionOptions.host = newValues.host;
        self.connectionOptions.port = newValues.port;
        self.connectionOptions.model = newValues.model;
        
        if (eiscp.is_connected) {
            eiscp.close();
        }
        
        eiscp.connect(self.connectionOptions);
    }
    
    self.commandRouter.pushToastMessage('success', self.getI18nString("SETTINGS_SAVED"), self.getI18nString("SETTINGS_SAVED_CONNECTION"));
    self.refreshUIConfig();

    return 1;
};

onkyoControl.prototype.saveActionConfig = function (data) {
    var self = this;


    self.logger.debug("ONKYO-CONTROL: saveActionConfig() data: " + JSON.stringify(data));

    self.config.set('powerOn', data['powerOn']);
    self.config.set('standby', data['standby']);
    self.config.set('zone', data['zone'].value);

    if (data['standbyDelay'] <= 0) {
        self.config.set('standbyDelay', 0);
    }
    else {
        self.config.set('standbyDelay', data['standbyDelay']);
    }

    self.config.set('setVolume', data['setVolume']);

    if (data['setVolumeValue'] <= 0) {
        self.config.set('setVolumeValue', 0);
    }
    else {
        self.config.set('setVolumeValue', data['setVolumeValue']);
    }

    if (data['maxVolume'] <= 0) {
        self.config.set('maxVolume', 0);
    }
    else {
        self.config.set('maxVolume', data['maxVolume']);
    }

    self.config.set('setInput', data['setInput']);
    if (data['setInputValue']) {
        self.config.set('setInputValue', data['setInputValue'].value);
    }
    else {
        self.config.set('setInputValue', 'line1');
    }

    self.commandRouter.pushToastMessage('success', self.getI18nString("SETTINGS_SAVED"), self.getI18nString("SETTINGS_SAVED_ACTION"));

    return 1;
};

// Internationalisation Methods -----------------------------------------------------------------------------

onkyoControl.prototype.load18nStrings = function () {
    var self = this;

    try {
        var language_code = this.commandRouter.sharedVars.get('language_code');
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_' + language_code + ".json");
    }
    catch (e) {
        self.i18nStrings = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
    }

    self.i18nStringsDefaults = fs.readJsonSync(__dirname + '/i18n/strings_en.json');
};

onkyoControl.prototype.getI18nString = function (key) {
    var self = this;

    if (self.i18nStrings[key] !== undefined) {
        return self.i18nStrings[key];
    }
    else {
        return self.i18nStringsDefaults[key];
    }
};

onkyoControl.prototype.callReceiver = function (args) {
    const self = this;
    /*
        If we aren't connected, wait 500ms to see if we connect.
        If we still aren't connected, wait 5000ms and try again.
        If we still aren't connected, give up.
    */
        
    if (!eiscp.is_connected && args.waitToSend <= 5000) {
        
        const waitToSend = (args.waitToSend === 500) ? 5000 : 9999;
        setTimeout(() => {
            self.callReceiver({
                "action": args.action,
                "value": args.value,
                "waitToSend" : waitToSend,
            });
        }, args.waitToSend);
    }
    else if (eiscp.is_connected) {
        
        const zone = self.config.get('zone', 'main');
        /*
            Onkyo expects volume to be in the range of 0 - 200. To make it easier
            for users, we will do a conversion here before sending it out.

            If this becomes something that is a habit, we should refactor this a bit
            for now since only volume needs to be manipulated for every call, we
            will leave it here.
        */
        args.value = (args.action === 'volume') ? args.value * 2 : args.value;
        self.logger.debug(`ONKYO COMMAND: ${zone}.${args.action}=${args.value}`);
        eiscp.command(`${zone}.${args.action}=${args.value}`);
    }
    else if (!eiscp.is_connected) {
        
        // Give up, there is no more
        self.logger.error("ONKYO-CONTROL: Error sending command. Not Connected");

        // For giggles, try one more time to connect.
        eiscp.connect(self.connectionOptions);
    }
}