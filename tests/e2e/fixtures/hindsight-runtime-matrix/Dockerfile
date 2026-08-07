FROM node:22-alpine
WORKDIR /service
COPY server.mjs ./server.mjs
ENV HINDSIGHT_FIXTURE_DATA_DIR=/data
EXPOSE 8888
CMD ["node", "server.mjs"]
