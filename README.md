![Duniter logo](https://raw.github.com/duniter/duniter/master/images/250×250.png)

# Duniter [![Build Status](https://api.travis-ci.org/duniter/duniter.png)](https://travis-ci.org/duniter/duniter) [![Coverage Status](https://coveralls.io/repos/github/duniter/duniter/badge.svg?branch=master)](https://coveralls.io/github/duniter/duniter?branch=master) [![Dependencies](https://david-dm.org/duniter/duniter.svg)](https://david-dm.org/duniter/duniter)

Duniter (previously uCoin) is a libre software allowing to create a new kind of P2P crypto-currencies based on individuals and Universal Dividend.

Inspired by [Bitcoin](https://github.com/bitcoin/bitcoin) and [OpenUDC](https://github.com/Open-UDC/open-udc) projects.

<p align="center"><img src="https://github.com/duniter/duniter/blob/master/images/duniter_admin_ui.png" /></p>

## Development state

Software is still under development, and **no production currency using Duniter exists for now**.

However, it already exists a testing currency named [Ğtest](https://forum.duniter.org/t/join-the-gtest-currency/1620). Want to test it? Two ways.

### Add your node to the network

See [Install a node documentation](https://github.com/duniter/duniter/blob/master/doc/install-a-node.md).

### Try Cesium Wallet
- [Try Cesium Wallet](http://cesium.duniter.fr)

### Try Sakia Wallet

In the world of crypto-currencies, [Sakia Wallet](http://sakia-wallet.org) ([repository](https://github.com/duniter/sakia)) would be called a [SPV](https://en.bitcoin.it/wiki/Thin_Client_Security#Simplified_Payment_Verification_.28SPV.29_Clients) client. It is a graphical client connecting to the network. See this [tutorial](https://forum.duniter.org/t/join-our-new-testnet-currency/813) to join in the testing currency with Sakia.

## Going further

### Contribute

- [Quick-start-guide : start a duniter node with web-ui from source](https://github.com/duniter/duniter/blob/master/doc/quick-start.md)
- [Guide (fr)](https://github.com/duniter/duniter/blob/master/doc/contribute-french.md)

### Documentation

Visit [Duniter website](https://duniter.org): it gathers theoretical informations, FAQ and several useful links. If you want to learn, this is the first place to visit.

### Talk about/get involved in Duniter project

If you wish to participate/debate on Duniter, you can:

* visit [Duniter Forum](https://forum.duniter.org)
* join XMPP chatroom [duniter@muc.duniter.org](https://chat.duniter.org)
* contact us directly at [contact@duniter.org](mailto:contact@duniter.org)

### Developement
Duniter is using modules on different git repositories:
- [Crawler](https://github.com/duniter/duniter-crawler): network crawler.
- [Prover](https://github.com/duniter/duniter-prover): handle Proof-of-Work.
- [BMA API](https://github.com/duniter/duniter-bma): Basic Merkled API.
- [Keypair](https://github.com/duniter/duniter-keypair): provide the cryptographic keypair.
- [WotB](https://github.com/duniter/wotb): compute Web of Trust.
- [Debug](https://github.com/duniter/duniter-debug): debug tool.
- [Web admin](https://github.com/duniter/duniter-ui): web administration interface (optional).

Optional modules:
- [Remuniter](https://github.com/duniter/remuniter): service to remunerate blocks issuers.
- [Wot explorer](https://github.com/c-geek/wotex): Web of Trust explorer.

# References

## Theoretical
* [[en] Relative theory of money](http://en.trm.creationmonetaire.info)
* [[fr] Théorie relative de la monaie](http://trm.creationmonetaire.info)

## OpenUDC

* [Official OpenUDC project website](http://www.openudc.org)
* [Official OpenUDC repository](https://github.com/Open-UDC/open-udc)
* [Other project trying to implement OpenUDC in python](https://github.com/canercandan/django-openudc)

# License

This software is distributed under [GNU AGPLv3](https://raw.github.com/duniter/duniter/master/LICENSE).
