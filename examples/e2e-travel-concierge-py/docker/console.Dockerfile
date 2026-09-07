# The Console is published as a pre-built multi-arch image from its own repo
# (helixid/helix-console -> docker.io/helixid/console), so this demo never
# needs a second checkout -- it just layers this example's nginx server block
# on top of that image.
#
# Why a one-line image instead of a bind mount: mounting a host file into the
# container depends on Docker Desktop's file-sharing settings, which aren't
# guaranteed on a stranger's machine. Baking it in makes `docker compose up`
# work everywhere.
#
# That server block same-origin-proxies /v1 and /health to helix-api, because
# the demo API ships without CORS and the Console calls it from the browser.
FROM helixid/console:latest
COPY console-nginx.conf /etc/nginx/conf.d/default.conf
