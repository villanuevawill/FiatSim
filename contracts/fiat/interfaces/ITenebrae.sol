// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.4;

import {ICodex} from "./ICodex.sol";
import {ICollateralAuction} from "./ICollateralAuction.sol";
import {ICollybus} from "./ICollybus.sol";
import {IAer} from "./IAer.sol";
import {ILimes} from "./ILimes.sol";
import {ITenebrae} from "./ITenebrae.sol";

interface ITenebrae {
    function codex() external view returns (ICodex);

    function limes() external view returns (ILimes);

    function aer() external view returns (IAer);

    function collybus() external view returns (ICollybus);

    function live() external view returns (uint256);

    function lockedAt() external view returns (uint256);

    function cooldownDuration() external view returns (uint256);

    function debt() external view returns (uint256);

    function lostCollateral(address, uint256) external view returns (uint256);

    function normalDebtByTokenId(address, uint256) external view returns (uint256);

    function claimed(
        address,
        uint256,
        address
    ) external view returns (uint256);

    function setParam(bytes32 param, address data) external;

    function setParam(bytes32 param, uint256 data) external;

    function lockPrice(address vault, uint256 tokenId) external view returns (uint256);

    function redemptionPrice(address vault, uint256 tokenId) external view returns (uint256);

    function lock() external;

    function skipAuction(address vault, uint256 auctionId) external;

    function offsetPosition(
        address vault,
        uint256 tokenId,
        address user
    ) external;

    function closePosition(address vault, uint256 tokenId) external;

    function fixGlobalDebt() external;

    function redeem(
        address vault,
        uint256 tokenId,
        uint256 credit
    ) external;
}
