// handle vote
// Coded with Cairo 2.15.2
// contract not audited ; use at your own risks.

#[starknet::interface]
pub trait IMerkleVerify<TContractState> {
    fn submit_vote(
        ref self: TContractState,
        proof: Span<felt252>,
        merkle_root: felt252,
        vote: u8,
        nullifier: felt252,
        round: felt252,
    );
    fn verify_stwo_proof(
        self: @TContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
    ) -> bool;
    fn get_tally(self: @TContractState, round: felt252, option: u8) -> u256;
    fn get_merkle_root(self: @TContractState) -> felt252;
    fn is_nullifier_used(self: @TContractState, round: felt252, nullifier: felt252) -> bool;
    fn update_merkle_root(ref self: TContractState, new_root: felt252);
    fn close_round(ref self: TContractState, round: felt252);
}

#[starknet::contract]
mod PrivateVoteVerifierMultiRound {
    use core::array::ArrayTrait;
    use core::traits::Into;
    use starknet::storage::{
        Map, StorageMapReadAccess, StorageMapWriteAccess, StoragePointerReadAccess,
        StoragePointerWriteAccess,
    };
    use starknet::syscalls::get_execution_info_syscall;
    use starknet::{ContractAddress, ExecutionInfo, SyscallResultTrait, TxInfo, get_caller_address};

    // ──────────────────────────────────────────────
    // Storage
    // ──────────────────────────────────────────────
    #[storage]
    struct Storage {
        verifier_address: ContractAddress,
        merkle_root: felt252,
        used_nullifiers: Map<(felt252, felt252), bool>,
        tally: Map<(felt252, u8), u256>,
        owner: ContractAddress,
    }

    // ──────────────────────────────────────────────
    // Events
    // ──────────────────────────────────────────────
    #[event]
    #[derive(Drop, starknet::Event)]
    enum Event {
        VoteVerified: VoteVerified,
        VoteAdded: VoteAdded,
        RoundClosed: RoundClosed,
    }

    #[derive(Drop, starknet::Event)]
    struct VoteVerified {
        #[key]
        round: felt252,
        #[key]
        voter: ContractAddress,
        #[key]
        vote: u8,
        #[key]
        nullifier: felt252,
    }

    #[derive(Drop, starknet::Event)]
    struct VoteAdded {
        #[key]
        round: felt252,
        #[key]
        vote: u8,
    }

    #[derive(Drop, starknet::Event)]
    struct RoundClosed {
        #[key]
        round: felt252,
    }

    // ──────────────────────────────────────────────
    // Constructor
    // ──────────────────────────────────────────────
    #[constructor]
    fn constructor(
        ref self: ContractState, verifier_address: ContractAddress, merkle_root: felt252,
    ) {
        self.verifier_address.write(verifier_address);
        self.merkle_root.write(merkle_root);
        self.owner.write(get_caller_address());
    }

    // ──────────────────────────────────────────────
    // Trait pour les méthodes external
    // ──────────────────────────────────────────────
    #[abi(embed_v0)]
    impl ProofVerifyContract of super::IMerkleVerify<ContractState> {
        fn submit_vote(
            ref self: ContractState,
            proof: Span<felt252>,
            merkle_root: felt252,
            vote: u8,
            nullifier: felt252,
            round: felt252,
        ) {
            assert(vote <= 3, 'Invalid vote');

            assert(self.merkle_root.read() == merkle_root, 'Invalid root');

            let nullifier_key = (round, nullifier);
            assert(!self.used_nullifiers.read(nullifier_key), 'Nullifier used');

            // ******** With SNIP-36
        //     // 2. Récupérer les faits de la preuve via SNIP-36
        //     let info: ExecutionInfo = get_execution_info_syscall().unwrap_syscall().unbox();
        //     let tx_info: TxInfo = info.tx_info.unbox();

        //     // Les faits de preuve sont dans proof_facts (Span<felt252>)
        //     let proof_facts = tx_info.proof_facts;

        //     // Vérifier qu'il y a bien une preuve S-two dans la transaction
        //     assert(proof_facts.len() > 0, 'No proof facts provided');
        //     // Vérifier que les faits correspondent aux public inputs
        // // Ordre attendu : merkle_root, vote, nullifier, round
        // assert(proof_facts.at(0) == merkle_root, 'Proof mismatch merkle_root');
        // assert(proof_facts.at(1) == vote.into(), 'Proof mismatch vote');
        // assert(proof_facts.at(2) == nullifier, 'Proof mismatch nullifier');
        // assert(proof_facts.at(3) == round, 'Proof mismatch round');
        // *******************

            assert(
                self
                    .verify_stwo_proof(
                        proof, array![merkle_root, vote.into(), nullifier, round].span(),
                    ),
                'Invalid proof',
            );

            self.used_nullifiers.write(nullifier_key, true);

            let tally_key = (round, vote);
            let current = self.tally.read(tally_key);
            self.tally.write(tally_key, current + 1);

            self.emit(VoteVerified { round, voter: get_caller_address(), vote, nullifier });
            self.emit(VoteAdded { round, vote });
        }

        fn verify_stwo_proof(
            self: @ContractState, proof: Span<felt252>, public_inputs: Span<felt252>,
        ) -> bool {
            // Placeholder – SNIP-36 : utiliser proof_facts du tx_info
            // Sinon : appeler un vérificateur externe

            true
        }

        fn get_tally(self: @ContractState, round: felt252, option: u8) -> u256 {
            assert(option <= 3, 'Invalid option');
            let key = (round, option);
            self.tally.read(key)
        }

        fn get_merkle_root(self: @ContractState) -> felt252 {
            self.merkle_root.read()
        }

        fn is_nullifier_used(self: @ContractState, round: felt252, nullifier: felt252) -> bool {
            let key = (round, nullifier);
            self.used_nullifiers.read(key)
        }

        fn update_merkle_root(ref self: ContractState, new_root: felt252) {
            assert(get_caller_address() == self.owner.read(), 'Only owner');
            self.merkle_root.write(new_root);
        }

        fn close_round(ref self: ContractState, round: felt252) {
            assert(get_caller_address() == self.owner.read(), 'Only owner');
            self.emit(RoundClosed { round });
        }
    }
}
