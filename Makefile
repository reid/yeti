all: install

test:
	vows test/*.js

install-stable:
	npm install yeti

install:
	npm -g install .

link:
	npm link .

remove:
	npm -g uninstall yeti

.PHONY: all install-stable install link remove test
