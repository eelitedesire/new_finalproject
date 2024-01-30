FROM node

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

HEALTHCHECK --interval=30s CMD node healthcheck.js
CMD ["node", "app.js"]
