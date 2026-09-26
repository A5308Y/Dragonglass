# The proxy has no dependencies beyond Node itself.
FROM node:22-alpine
WORKDIR /opt/proxy
COPY proxy.mjs ./
USER node
EXPOSE 8080
CMD ["node", "/opt/proxy/proxy.mjs"]
