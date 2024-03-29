FROM node:14-alpine

# Set metadata
LABEL \
    io.hass.name="Carbonoz Solarpilot" \
    io.hass.description="CARBONOZ Solarpilot on Homeassistant runs in a Docker container and will be offered in the Homeassistant Addon store for download." \
    io.hass.arch="aarch64,amd64,armv7" \
    io.hass.type="addon" \
    io.hass.version="1.0.0"

# Copy data
COPY . /app

# Install dependencies
RUN \
    apk add --no-cache \
        nodejs \
        npm \
    && npm install --prefix /app

# Set the working directory
WORKDIR /app

# Expose the port
EXPOSE 4000

# Start the app with increased memory limit
CMD [ "node", "--max-old-space-size=4096", "app.js" ]
