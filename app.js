const express = require('express');
const bodyParser = require('body-parser');
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');
const Influx = require('influx');
const moment = require('moment');
const ejs = require('ejs');
const fetch = require('node-fetch');

const app = express();
const port = 2000;

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');

// InfluxDB configuration
const influxConfig = {
    host: 'localhost',
    port: 8086,
    database: 'homeassistant',
    username: 'admin',
    password: 'adminadmin',
};

const influx = new Influx.InfluxDB(influxConfig);

// MQTT configuration
let mqttConfig = loadMqttConfig();
let mqttClient = connectToMqtt();

// Array to store incoming messages
let incomingMessages = [];

// Home Assistant configuration
const homeAssistantUrl = 'http://192.168.160.55:8123/api/states';
const homeAssistantToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiI3OGY4ODY2ZWU1MDg0N2FiYmNlMzk5MGUxNjgzNzdiZSIsImlhdCI6MTcwOTA1MjAzMywiZXhwIjoyMDI0NDEyMDMzfQ.6YDJLIGS7YtPLbdtSClcUf_CFAm9U3VFkpKBJXMJkwM';

// Express routes
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

app.get('/settings', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});
app.get('/charts', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'charts.html'));
});


app.post('/updateConfig', (req, res) => {
    mqttConfig = {
        mqttIp: req.body.mqttIp,
        username: req.body.username,
        password: req.body.password,
        inverterType: req.body.inverterType,
        batteryType: req.body.batteryType,
    };

    saveMqttConfig(mqttConfig);

    mqttClient.end();
    mqttClient = connectToMqtt();

    res.redirect('/status');
});

app.get('/status', (req, res) => {
    if (mqttClient) {
        res.sendFile(__dirname + '/public/success.html');
    } else {
        res.sendFile(__dirname + '/public/contact.html');
    }
});

app.get('/messages', (req, res) => {
    res.sendFile(__dirname + '/public/messages.html');
});

app.get('/api/messages', (req, res) => {
    const categoryFilter = req.query.category;
    const filteredMessages = filterMessagesByCategory(categoryFilter);
    res.json(filteredMessages);
});

app.get('/analytics', async (req, res) => {
    try {
        const loadPowerData = await queryInfluxDB('solar_assistant_DEYE/total/load_power/state');
        const pvPowerData = await queryInfluxDB('solar_assistant_DEYE/total/pv_power/state');
        const batteryStateOfChargeData = await queryInfluxDB('solar_assistant_DEYE/total/battery_state_of_charge/state');
        const batteryPowerData = await queryInfluxDB('solar_assistant_DEYE/total/battery_power/state');
        const gridPowerData = await queryInfluxDB('solar_assistant_DEYE/total/grid_power/state');

        const data = {
            loadPowerData,
            pvPowerData,
            batteryStateOfChargeData,
            batteryPowerData,
            gridPowerData,
        };

        res.render('analytics', { data });
    } catch (error) {
        console.error('Error fetching data from InfluxDB:', error);
        res.status(500).send('Error fetching data from InfluxDB');
    }
});

app.listen(port, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${port}`);
});

function filterMessagesByCategory(category) {
    if (category && category !== 'all') {
        return incomingMessages.filter(message => {
            const keywords = getCategoryKeywords(category);
            return keywords.some(keyword => message.includes(keyword));
        });
    }
    return incomingMessages;
}

function getCategoryKeywords(category) {
    switch (category) {
        case 'inverter1':
            return ['inverter_1'];
        case 'inverter2':
            return ['inverter_2'];
        case 'loadPower':
            return ['load_power'];
        case 'gridPower':
            return ['grid_power'];
        default:
            return [];
    }
}

function loadMqttConfig() {
    try {
        const configData = fs.readFileSync('mqttConfig.json');
        return JSON.parse(configData);
    } catch (error) {
        return {};
    }
}

function saveMqttConfig(config) {
    fs.writeFileSync('mqttConfig.json', JSON.stringify(config, null, 2));
}

function connectToMqtt() {
    const { mqttIp, username, password } = mqttConfig;
    const client = mqtt.connect(`mqtt://${mqttIp}`, {
        username,
        password,
    });

    client.on('connect', () => {
        console.log('Connected to MQTT broker');
        client.subscribe('solar_assistant_DEYE/#');
    });

    client.on('message', (topic, message) => {
        const formattedMessage = `${topic}: ${message.toString()}`;
        console.log(`Received message: ${formattedMessage}`);
        incomingMessages.push(formattedMessage);
        saveMessageToInfluxDB(topic, message);
        sendDataToHomeAssistant(topic, message);
    });

    client.on('error', (err) => {
        console.error('Error connecting to MQTT broker:', err.message);
        mqttClient = null;
    });

    return client;
}

function saveMessageToInfluxDB(topic, message) {
    try {
        const parsedMessage = parseFloat(message.toString());

        if (isNaN(parsedMessage)) {
            console.error('Error parsing message payload. Not a valid number:', message.toString());
            return;
        }

        const timestamp = new Date().getTime();
        const dataPoint = {
            measurement: 'state',
            fields: { value: parsedMessage },
            tags: { topic: topic },
            timestamp: timestamp * 1000000,
        };

        influx.writePoints([dataPoint])
            .then(() => {
                console.log('Message saved to InfluxDB');
            })
            .catch((err) => {
                console.error('Error saving message to InfluxDB:', err.toString());
            });
    } catch (error) {
        console.error('Error parsing message:', error.message);
    }
}

async function queryInfluxDB(topic) {
    const query = `
    SELECT mean("value") AS "value"
    FROM "state"
    WHERE "topic" = '${topic}'
    AND time >= now() - 30d
    GROUP BY time(1d)
    `;

    try {
        const result = await influx.query(query);
        return result;
    } catch (error) {
        console.error(`Error querying InfluxDB for topic ${topic}:`, error);
        return [];
    }
}

async function sendDataToHomeAssistant(topic, message) {
    const state = message.toString();
    const data = {
        state,
        attributes: {
            friendly_name: `Solar Assistant ${topic}`,
            unit_of_measurement: 'value',
        }
    };

    try {
        const response = await fetch(homeAssistantUrl, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${homeAssistantToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        if (response.ok) {
            console.log(`Data sent to Home Assistant successfully for topic ${topic}`);
        } else if (response.status === 405) {
            console.error(`Method not allowed for topic ${topic}. Please check your Home Assistant configuration.`);
          
        } else {
            console.error(`Failed to send data to Home Assistant for topic ${topic}:`, response.status);
           
        }
    } catch (error) {
        console.error(`Error sending data to Home Assistant for topic ${topic}:`, error);
      
    }
}


