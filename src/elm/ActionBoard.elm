port module ActionBoard exposing (main)

import Browser
import Browser.Dom
import Dict exposing (Dict)
import Gtd.ActionStatus as ActionStatus exposing (ActionStatus)
import Gtd.Command.ActionBoard as Command exposing (Command, MenuEntry(..))
import Gtd.Data as Data exposing (Action, Project, Snapshot)
import Gtd.Energy as Energy exposing (Energy)
import Gtd.Hierarchy as Hierarchy
import Gtd.Host as Host exposing (Requests)
import Gtd.Id exposing (ActionId, ProjectId)
import Gtd.ProjectStatus as ProjectStatus exposing (ProjectStatus)
import Gtd.Ranking as Ranking
import Gtd.Settings as Settings
    exposing
        ( BoardConfiguration
        , DueRange(..)
        , Filter(..)
        , GroupBy(..)
        , MatchOperator(..)
        , SortDirection(..)
        , SortField(..)
        , VisibleColumns(..)
        )
import Gtd.Ui as Ui exposing (Key(..))
import Html exposing (Html, article, button, div, h2, header, input, label, option, section, select, span, text)
import Html.Attributes exposing (attribute, checked, class, classList, disabled, draggable, id, placeholder, selected, tabindex, title, type_, value)
import Html.Events exposing (custom, on, onCheck, onClick, onInput)
import Json.Decode as Decode exposing (Decoder)
import Json.Encode as Encode
import Task


port toHost : Encode.Value -> Cmd msg


port fromHost : (Decode.Value -> msg) -> Sub msg


{-| Which bucket an Action falls into under the current grouping.
-}
type GroupKey
    = StatusGroup ActionStatus
    | ProjectGroup (Maybe ProjectId)
    | ContextGroup (Maybe String)
    | EnergyGroup (Maybe Energy)


type alias Group =
    { key : GroupKey, actions : List Action }


{-| The field a new filter asks about, as chosen in the builder.
-}
type FilterField
    = FieldStatus
    | FieldProject
    | FieldContext
    | FieldEnergy
    | FieldArea
    | FieldDue


{-| The comparison a due-date filter draft is set to, before it is given an operand.
-}
type DueOperator
    = OpBefore
    | OpOnOrBefore
    | OpAfter
    | OpOnOrAfter
    | OpWithinNextDays
    | OpIsEmpty
    | OpIsNotEmpty


type alias FilterDraft =
    { field : FilterField
    , operator : MatchOperator
    , value : String
    , dueOperator : DueOperator
    , dueValue : String
    }


{-| What a host reply should finish.
-}
type Pending
    = IgnoreReply
    | CreateSavedView
    | MoveAction ActionId ActionStatus
    | RankActions (List ActionId)


{-| A priority already shown on the board while the host writes it. `confirmed`
means the host has answered, so the next snapshot is authoritative either way.
-}
type alias PendingRank =
    { priority : Int, confirmed : Bool }


type alias Model =
    { snapshot : Snapshot
    , activeViewId : Maybe String
    , configuration : BoardConfiguration
    , search : String
    , allProjects : Bool
    , filterOpen : Bool
    , viewMenuOpen : Bool

    -- On a phone, whether search, filters and layout show; elsewhere they always do.
    , controlsOpen : Bool
    , draft : FilterDraft
    , dragged : Maybe ActionId
    , priorityDropTarget : Maybe ActionId
    , optimistic : Dict ActionId ActionStatus
    , optimisticRanks : Dict ActionId PendingRank
    , savedViewSeed : Int
    , requests : Requests Pending
    , fatalError : Maybe String
    }


type Msg
    = GotHost Decode.Value
    | SearchChanged String
    | ToggleAllProjects Bool
    | ToggleFilters
    | ToggleControls
    | ToggleViewMenu
    | SelectSavedView String
    | SetGroupBy GroupBy
    | SetSections (Maybe GroupBy)
    | SetSortField SortField
    | ReverseSort
    | SaveView
    | SaveViewAs
    | DeleteView
    | SetFilterField FilterField
    | SetFilterOperator MatchOperator
    | SetFilterValue String
    | SetDueOperator DueOperator
    | SetDueValue String
    | AddFilter
    | RemoveFilter Int
    | ToggleColumn GroupKey
    | DragStarted ActionId
    | DragOver
    | DragOverCard ActionId
    | DragEnded
    | DropOn ActionStatus
    | DropBefore ActionId
    | CardKey ActionId Key
    | ToggleDone ActionId Bool
    | Focused (Result Browser.Dom.Error ())
    | Send Pending Command
    | NoOp


main : Program Decode.Value Model Msg
main =
    Browser.element
        { init = init
        , update = update
        , subscriptions = \_ -> fromHost GotHost
        , view = view
        }


init : Decode.Value -> ( Model, Cmd Msg )
init flags =
    case Decode.decodeValue Data.snapshotDecoder flags of
        Ok snapshot ->
            let
                active =
                    snapshot.settings.activeSavedViewId

                configuration =
                    active
                        |> Maybe.andThen (Settings.findSavedView snapshot.settings.savedViews)
                        |> Maybe.map .configuration
                        |> Maybe.withDefault (Settings.defaultConfiguration snapshot.settings)
            in
            ( initialModel snapshot active configuration, Cmd.none )

        Err error ->
            let
                fallback =
                    initialModel Data.empty Nothing (Settings.defaultConfiguration Settings.empty)
            in
            ( { fallback | fatalError = Just (Decode.errorToString error) }, Cmd.none )


initialModel : Snapshot -> Maybe String -> BoardConfiguration -> Model
initialModel snapshot active configuration =
    { snapshot = snapshot
    , activeViewId = active
    , configuration = configuration
    , search = ""
    , allProjects = False
    , filterOpen = False
    , viewMenuOpen = False
    , controlsOpen = False
    , draft = initialDraft snapshot.today
    , dragged = Nothing
    , priorityDropTarget = Nothing
    , optimistic = Dict.empty
    , optimisticRanks = Dict.empty
    , savedViewSeed = 1
    , requests = Host.noRequests
    , fatalError = Nothing
    }


initialDraft : String -> FilterDraft
initialDraft today =
    { field = FieldStatus
    , operator = Is
    , value = ActionStatus.key ActionStatus.Next
    , dueOperator = OpOnOrBefore
    , dueValue = today
    }


update : Msg -> Model -> ( Model, Cmd Msg )
update msg model =
    case msg of
        GotHost value ->
            receiveHost value model

        SearchChanged query ->
            ( { model | search = query }, Cmd.none )

        ToggleAllProjects shown ->
            ( { model | allProjects = shown }, Cmd.none )

        ToggleFilters ->
            ( { model | filterOpen = not model.filterOpen }, Cmd.none )

        ToggleControls ->
            ( { model | controlsOpen = not model.controlsOpen }, Cmd.none )

        ToggleViewMenu ->
            ( { model | viewMenuOpen = not model.viewMenuOpen }, Cmd.none )

        SelectSavedView savedId ->
            let
                selectedView =
                    Settings.findSavedView model.snapshot.settings.savedViews savedId

                nextId =
                    Maybe.map .id selectedView

                configuration =
                    Maybe.map .configuration selectedView
                        |> Maybe.withDefault (Settings.defaultConfiguration model.snapshot.settings)

                settings =
                    model.snapshot.settings
            in
            send IgnoreReply
                (Command.SetActiveSavedView nextId)
                { model | activeViewId = nextId, configuration = configuration }

        SetGroupBy groupBy ->
            ( { model
                | configuration =
                    withConfiguration model
                        (\config ->
                            { config
                                | groupBy = groupBy
                                , visibleColumns = AllColumns

                                -- A column is never split by the field it already is.
                                , sections =
                                    if config.sections == Just groupBy then
                                        Nothing

                                    else
                                        config.sections
                            }
                        )
              }
            , Cmd.none
            )

        SetSections sections ->
            ( { model | configuration = withConfiguration model (\config -> { config | sections = sections }) }, Cmd.none )

        SetSortField field ->
            ( { model
                | configuration =
                    withConfiguration model (\config -> { config | sort = { field = field, direction = config.sort.direction } })
              }
            , Cmd.none
            )

        ReverseSort ->
            ( { model
                | configuration =
                    withConfiguration model
                        (\config -> { config | sort = { field = config.sort.field, direction = Settings.reverse config.sort.direction } })
              }
            , Cmd.none
            )

        SaveView ->
            let
                closed =
                    { model | viewMenuOpen = False }
            in
            case closed.activeViewId of
                Just _ ->
                    saveCurrentView closed

                Nothing ->
                    promptForView False closed

        SaveViewAs ->
            promptForView True { model | viewMenuOpen = False }

        DeleteView ->
            deleteCurrentView { model | viewMenuOpen = False }

        SetFilterField field ->
            let
                draft =
                    model.draft

                switched =
                    { model | draft = { draft | field = field } }
            in
            -- Start from the option the value select shows first, so adding the
            -- filter untouched filters on what is on screen.
            ( { switched
                | draft =
                    { draft
                        | field = field
                        , value = filterValues switched |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault ""
                    }
              }
            , Cmd.none
            )

        SetFilterOperator operator ->
            ( { model | draft = withDraft model (\draft -> { draft | operator = operator }) }, Cmd.none )

        SetFilterValue next ->
            ( { model | draft = withDraft model (\draft -> { draft | value = next }) }, Cmd.none )

        SetDueOperator operator ->
            ( { model
                | draft =
                    withDraft model
                        (\draft ->
                            { draft
                                | dueOperator = operator
                                , dueValue =
                                    if operator == OpWithinNextDays then
                                        "7"

                                    else
                                        model.snapshot.today
                            }
                        )
              }
            , Cmd.none
            )

        SetDueValue next ->
            ( { model | draft = withDraft model (\draft -> { draft | dueValue = next }) }, Cmd.none )

        AddFilter ->
            case draftFilter model of
                Just filter ->
                    ( { model | configuration = withConfiguration model (\config -> { config | filters = addFilter filter config.filters }) }, Cmd.none )

                Nothing ->
                    ( model, Cmd.none )

        RemoveFilter index ->
            ( { model | configuration = withConfiguration model (\config -> { config | filters = removeAt index config.filters }) }, Cmd.none )

        ToggleColumn key ->
            let
                shown =
                    columnCandidates model |> List.map groupKeyString

                visible =
                    case model.configuration.visibleColumns of
                        AllColumns ->
                            shown

                        OnlyColumns columns ->
                            columns

                wanted =
                    groupKeyString key

                next =
                    if List.member wanted visible then
                        List.filter ((/=) wanted) visible

                    else
                        List.filter (\candidate -> candidate == wanted || List.member candidate visible) shown
            in
            ( { model | configuration = withConfiguration model (\config -> { config | visibleColumns = OnlyColumns next }) }, Cmd.none )

        DragStarted actionId ->
            ( { model | dragged = Just actionId, priorityDropTarget = Nothing }, Cmd.none )

        DragOver ->
            ( { model | priorityDropTarget = Nothing }, Cmd.none )

        DragOverCard actionId ->
            ( { model | priorityDropTarget = Just actionId }, Cmd.none )

        DragEnded ->
            ( { model | dragged = Nothing, priorityDropTarget = Nothing }, Cmd.none )

        DropOn status ->
            case model.dragged of
                Just actionId ->
                    moveAction actionId status { model | dragged = Nothing, priorityDropTarget = Nothing }

                Nothing ->
                    ( model, Cmd.none )

        DropBefore targetId ->
            case model.dragged of
                Just actionId ->
                    if actionId == targetId then
                        ( { model | dragged = Nothing, priorityDropTarget = Nothing }, Cmd.none )

                    else
                        let
                            order =
                                priorityOrder model actionId targetId

                            -- The same ranks the host will write, shown straight away.
                            ranks =
                                order
                                    |> List.filterMap (\id -> Data.findAction id model.snapshot.actions)
                                    |> List.map (\action -> ( action.id, (effectiveAction model action).priority ))
                                    |> Ranking.ranksForOrder
                                    |> Dict.map (\_ priority -> { priority = priority, confirmed = False })

                            -- Reordering by hand is the Manual sort. The ranking starts from the
                            -- order on screen, so switching to it moves only the dropped card.
                            ( ranked, rankCmd ) =
                                send (RankActions (Dict.keys ranks))
                                    (Command.SetActionPriorities order)
                                    { model
                                        | dragged = Nothing
                                        , priorityDropTarget = Nothing
                                        , optimisticRanks = Dict.union ranks model.optimisticRanks
                                        , configuration =
                                            withConfiguration model
                                                (\config -> { config | sort = { field = SortByManual, direction = Ascending } })
                                    }
                        in
                        -- A card dropped onto a card in another status column joins that status too.
                        case crossColumnStatus model actionId targetId of
                            Just status ->
                                let
                                    ( moved, moveCmd ) =
                                        moveAction actionId status ranked
                                in
                                ( moved, Cmd.batch [ rankCmd, moveCmd ] )

                            Nothing ->
                                ( ranked, rankCmd )

                Nothing ->
                    ( model, Cmd.none )

        -- Ticked, the card is done; unticked again, it reopens as a Next Action.
        ToggleDone actionId done ->
            moveAction actionId
                (if done then
                    ActionStatus.Done

                 else
                    ActionStatus.Next
                )
                model

        CardKey actionId key ->
            case key of
                Character "d" ->
                    moveAction actionId ActionStatus.Done model

                Character "n" ->
                    moveAction actionId ActionStatus.Next model

                Character "w" ->
                    moveAction actionId ActionStatus.Waiting model

                Character "c" ->
                    moveAction actionId ActionStatus.Scheduled model

                Character "e" ->
                    send IgnoreReply (Command.EditActionModal actionId) model

                Enter ->
                    send IgnoreReply (Command.EditActionModal actionId) model

                ArrowDown ->
                    ( model, focusAdjacent 1 actionId model )

                ArrowUp ->
                    ( model, focusAdjacent -1 actionId model )

                _ ->
                    ( model, Cmd.none )

        Focused _ ->
            ( model, Cmd.none )

        Send pending command ->
            send pending command model

        NoOp ->
            ( model, Cmd.none )


withConfiguration : Model -> (BoardConfiguration -> BoardConfiguration) -> BoardConfiguration
withConfiguration model change =
    change model.configuration


withDraft : Model -> (FilterDraft -> FilterDraft) -> FilterDraft
withDraft model change =
    change model.draft


send : Pending -> Command -> Model -> ( Model, Cmd Msg )
send pending command model =
    let
        ( requestId, requests ) =
            Host.issue pending model.requests

        optimistic =
            case pending of
                MoveAction actionId status ->
                    Dict.insert actionId status model.optimistic

                _ ->
                    model.optimistic
    in
    ( { model | requests = requests, optimistic = optimistic }
    , toHost (Host.envelope requestId (Command.encode command))
    )


{-| Moves a card straight away and lets the host correct it if the write fails.
A move that still needs something opens an editor instead, so no card is shown in
a column its file has not reached: the Action editor for a status that needs a
context the card lacks (a Waiting Action has none), the scheduler for a Calendar
Action without a time.
-}
moveAction : ActionId -> ActionStatus -> Model -> ( Model, Cmd Msg )
moveAction actionId status model =
    case Data.findAction actionId model.snapshot.actions of
        Nothing ->
            ( model, Cmd.none )

        Just action ->
            if action.status == status then
                ( model, Cmd.none )

            else
                send
                    (if ActionStatus.requiresContext status && String.isEmpty (String.trim (Maybe.withDefault "" action.context)) then
                        IgnoreReply

                     else if status == ActionStatus.Scheduled && Data.schedule action == Nothing then
                        IgnoreReply

                     else
                        MoveAction actionId status
                    )
                    (Command.SetActionStatus actionId status)
                    model


{-| The status of the column a card was dropped into, when the board is grouped by
status and that column is not the card's own.
-}
crossColumnStatus : Model -> ActionId -> ActionId -> Maybe ActionStatus
crossColumnStatus model actionId targetId =
    let
        statusOf id =
            Data.findAction id model.snapshot.actions
                |> Maybe.map (\action -> Dict.get action.id model.optimistic |> Maybe.withDefault action.status)
    in
    case ( model.configuration.groupBy, statusOf actionId, statusOf targetId ) of
        ( GroupByStatus, Just own, Just target ) ->
            if own /= target && target /= ActionStatus.Cancelled then
                Just target

            else
                Nothing

        _ ->
            Nothing


focusAdjacent : Int -> ActionId -> Model -> Cmd Msg
focusAdjacent offset actionId model =
    let
        ids =
            buildGroups model |> List.concatMap (.actions >> List.map .id)

        position =
            ids |> List.indexedMap Tuple.pair |> List.filter (\( _, id ) -> id == actionId) |> List.head |> Maybe.map Tuple.first
    in
    case position |> Maybe.andThen (\index -> List.drop (index + offset) ids |> List.head) of
        Just target ->
            Browser.Dom.focus (cardDomId target) |> Task.attempt Focused

        Nothing ->
            Cmd.none


saveCurrentView : Model -> ( Model, Cmd Msg )
saveCurrentView model =
    case model.activeViewId of
        Nothing ->
            promptForView False model

        Just activeId ->
            let
                settings =
                    model.snapshot.settings

                views =
                    List.map
                        (\saved ->
                            if saved.id == activeId then
                                { saved | configuration = model.configuration }

                            else
                                saved
                        )
                        settings.savedViews
            in
            case List.filter (\saved -> saved.id == activeId) views |> List.head of
                Just saved ->
                    send IgnoreReply (Command.UpsertSavedView saved False) model

                Nothing ->
                    ( model, Cmd.none )


promptForView : Bool -> Model -> ( Model, Cmd Msg )
promptForView saveAs model =
    let
        activeName =
            model.activeViewId
                |> Maybe.andThen (Settings.findSavedView model.snapshot.settings.savedViews)
                |> Maybe.map .name
    in
    send CreateSavedView
        (Command.Prompt
            { title =
                if saveAs then
                    "Save board view as"

                else
                    "Save board view"
            , placeholder =
                if saveAs then
                    Maybe.map (\name -> name ++ " copy") activeName |> Maybe.withDefault "View name"

                else
                    "View name"
            }
        )
        model


createSavedView : String -> Model -> ( Model, Cmd Msg )
createSavedView name model =
    let
        -- The seed only ever grows, so two views saved before a snapshot lands still differ.
        viewId =
            "view-" ++ String.fromInt model.snapshot.revision ++ "-" ++ String.fromInt model.savedViewSeed

        saved =
            { id = viewId, name = name, configuration = model.configuration }
    in
    send IgnoreReply
        (Command.UpsertSavedView saved True)
        { model | activeViewId = Just viewId, savedViewSeed = model.savedViewSeed + 1 }


deleteCurrentView : Model -> ( Model, Cmd Msg )
deleteCurrentView model =
    case model.activeViewId of
        Nothing ->
            ( model, Cmd.none )

        Just activeId ->
            let
                settings =
                    model.snapshot.settings
            in
            send IgnoreReply
                (Command.DeleteSavedView activeId)
                { model | activeViewId = Nothing, configuration = Settings.defaultConfiguration settings }



-- HOST EVENTS


type HostEvent
    = SnapshotEvent Snapshot
    | Replied Host.Outcome


receiveHost : Decode.Value -> Model -> ( Model, Cmd Msg )
receiveHost value model =
    case Decode.decodeValue hostEventDecoder value of
        Ok (SnapshotEvent snapshot) ->
            ( { model
                | snapshot = snapshot
                , optimistic = Dict.filter (\actionId status -> not (converged actionId status snapshot)) model.optimistic
                , optimisticRanks =
                    Dict.filter (\actionId rank -> not rank.confirmed && not (rankLanded actionId rank snapshot)) model.optimisticRanks
                , fatalError = Nothing
              }
            , Cmd.none
            )

        Ok (Replied outcome) ->
            let
                ( pending, requests ) =
                    Host.resolve outcome.requestId model.requests

                next =
                    { model | requests = requests }
            in
            case ( outcome.result, Maybe.withDefault IgnoreReply pending ) of
                ( Ok resultValue, CreateSavedView ) ->
                    case Decode.decodeValue Decode.string resultValue of
                        Ok name ->
                            createSavedView name next

                        Err _ ->
                            ( next, Cmd.none )

                ( Ok _, RankActions actionIds ) ->
                    -- Written. The snapshot that follows is the truth, even if it differs from what was shown.
                    ( { next
                        | optimisticRanks =
                            List.foldl (\actionId ranks -> Dict.update actionId (Maybe.map (\rank -> { rank | confirmed = True })) ranks)
                                next.optimisticRanks
                                actionIds
                      }
                    , Cmd.none
                    )

                ( Ok _, _ ) ->
                    ( next, Cmd.none )

                ( Err message, RankActions actionIds ) ->
                    ( { next | optimisticRanks = List.foldl Dict.remove next.optimisticRanks actionIds, fatalError = Just message }, Cmd.none )

                ( Err message, MoveAction actionId _ ) ->
                    ( { next | optimistic = Dict.remove actionId next.optimistic, fatalError = Just message }, Cmd.none )

                ( Err message, _ ) ->
                    ( { next | fatalError = Just message }, Cmd.none )

        Err error ->
            ( { model | fatalError = Just (Decode.errorToString error) }, Cmd.none )


{-| An Action as the board draws it: with the status and priority of moves the
host has not written yet.
-}
effectiveAction : Model -> Action -> Action
effectiveAction model action =
    { action
        | status = Dict.get action.id model.optimistic |> Maybe.withDefault action.status
        , priority =
            case Dict.get action.id model.optimisticRanks of
                Just rank ->
                    Just rank.priority

                Nothing ->
                    action.priority
    }


rankLanded : ActionId -> PendingRank -> Snapshot -> Bool
rankLanded actionId rank snapshot =
    Data.findAction actionId snapshot.actions
        |> Maybe.map (\action -> action.priority == Just rank.priority)
        |> Maybe.withDefault True


{-| An Action that needs attention today: overdue, a Waiting Action due for
follow-up, or a Calendar Action dated today or earlier. This is the rule behind the
Action Board's ribbon dot (`actionNeedsAttention` in `src/domain/attention.ts`);
change both together, or the dot points at cards the board does not mark.
-}
needsAttention : String -> Action -> Bool
needsAttention today action =
    let
        open =
            action.status /= ActionStatus.Done && action.status /= ActionStatus.Cancelled

        overdue =
            Maybe.map (\due -> due < today) action.due |> Maybe.withDefault False

        followUpDue =
            action.status == ActionStatus.Waiting && (Maybe.map (\date -> date <= today) action.followUp |> Maybe.withDefault False)

        -- The local day: a timed start carries it in `scheduledLocal`, since its UTC
        -- timestamp may fall on another date; an all-day start is the date itself.
        calendarDay =
            (case action.scheduledLocal of
                Just local ->
                    Just local

                Nothing ->
                    action.scheduledStart
            )
                |> Maybe.map (String.left 10)

        calendarDue =
            action.status == ActionStatus.Scheduled && (Maybe.map (\date -> date <= today) calendarDay |> Maybe.withDefault False)
    in
    open && (overdue || followUpDue || calendarDue)


{-| True once the vault agrees with a move the board already drew.
-}
converged : ActionId -> ActionStatus -> Snapshot -> Bool
converged actionId status snapshot =
    Data.findAction actionId snapshot.actions
        |> Maybe.map (\action -> action.status == status)
        |> Maybe.withDefault True



-- VIEW


view : Model -> Html Msg
view model =
    case model.fatalError of
        Just error ->
            div [ class "dg-view dg-board-view" ]
                [ div [ class "dg-panel dg-error" ] [ text ("Elm adapter error: " ++ error) ]
                , boardView model
                ]

        Nothing ->
            boardView model


boardView : Model -> Html Msg
boardView model =
    let
        groups =
            buildGroups model

        -- The count describes the cards on screen, not every Action in the vault.
        shown =
            groups |> List.map (.actions >> List.length) |> List.sum

        -- Few enough to choose from at a glance; the pill turns green to reward filtering down.
        focused =
            shown < 10

        -- What the ribbon dot counts, against what the current view shows of it.
        needing =
            model.snapshot.actions |> List.map (effectiveAction model) |> List.filter (needsAttention model.snapshot.today) |> List.length

        needingShown =
            groups |> List.concatMap .actions |> List.filter (needsAttention model.snapshot.today) |> List.length
    in
    div [ class "dg-view dg-board-view" ]
        [ header [ class "dg-view-header" ]
            [ div []
                [ h2 [] [ text "Actions" ]
                , span [ classList [ ( "dg-action-count", True ), ( "is-focused", focused ) ] ]
                    [ text
                        ((if focused then
                            "✓ "

                          else
                            ""
                         )
                            ++ Ui.plural shown "Action"
                        )
                    ]
                , if needing > 0 then
                    span [ class "dg-attention-summary" ]
                        [ span [ class "dg-attention-dot", attribute "aria-hidden" "true" ] []
                        , text
                            (String.fromInt needing
                                ++ " need"
                                ++ (if needing == 1 then
                                        "s"

                                    else
                                        ""
                                   )
                                ++ " attention"
                                ++ (if needingShown < needing then
                                        " · " ++ String.fromInt (needing - needingShown) ++ " not in this view"

                                    else
                                        ""
                                   )
                            )
                        ]

                  else
                    text ""
                ]
            , div [ class "dg-header-actions" ]
                [ button [ class "mod-cta", onClick (Send IgnoreReply (Command.NewActionModal Nothing)) ] [ text "New Action" ]
                , button [ onClick (Send IgnoreReply Command.QuickCapture) ] [ text "Quick Capture" ]
                , button [ onClick (Send IgnoreReply Command.OpenInbox) ] [ text "Open Inbox" ]
                ]
            ]
        , Ui.issuesView (\path -> Send IgnoreReply (Command.OpenFile path)) model.snapshot.issues
        , toolbar model
        , div [ classList [ ( "dg-board-refinements", True ), ( "is-open", model.controlsOpen ) ] ]
            [ if model.filterOpen then
                filterPanel model

              else
                text ""
            , filterChips model
            ]
        , div [ class "dg-shortcut-bar" ]
            [ span [ class "dg-shortcut-hint" ] [ text "On a focused card: ↑↓ move · N Next · W Waiting · C Calendar · D Done · E or Enter edit" ] ]
        , div [ classList [ ( "dg-board", True ), ( "is-single-column", List.length groups == 1 ) ], attribute "role" "list" ]
            (if List.isEmpty groups then
                [ div [ class "dg-empty" ] [ text "No Actions match this view." ] ]

             else
                List.map (groupView model) groups
            )
        ]


{-| The saved-view picker, then search, filters and layout. On a phone only the
picker shows at first, so the Actions fill the screen; one toggle brings the rest
(see `.dg-board-controls` in `styles.css`). Elsewhere the toggle is hidden and the
wrapper takes no part in the layout.
-}
toolbar : Model -> Html Msg
toolbar model =
    let
        refinements =
            activeRefinements model
                + (if String.isEmpty (String.trim model.search) then
                    0

                   else
                    1
                  )
    in
    div [ class "dg-toolbar" ]
        [ div [ class "dg-view-picker" ]
            [ Ui.labelled "Saved view"
                (select [ onInput SelectSavedView ]
                    (option [ value "", selected (model.activeViewId == Nothing) ] [ text "Board" ]
                        :: List.map
                            (\saved -> option [ value saved.id, selected (model.activeViewId == Just saved.id) ] [ text saved.name ])
                            model.snapshot.settings.savedViews
                    )
                )
            , button
                [ classList [ ( "is-active", model.viewMenuOpen ) ]
                , attribute "aria-expanded" (Ui.boolAttribute model.viewMenuOpen)
                , onClick ToggleViewMenu
                ]
                (Ui.iconLabel "•••" "Saved view options")
            , if model.viewMenuOpen then
                viewMenu model

              else
                text ""
            ]
        , button
            [ classList [ ( "dg-board-controls-toggle", True ), ( "is-active", model.controlsOpen ) ]
            , attribute "aria-expanded" (Ui.boolAttribute model.controlsOpen)
            , onClick ToggleControls
            ]
            [ text
                ("Search & filter"
                    ++ (if refinements > 0 then
                            " (" ++ String.fromInt refinements ++ ")"

                        else
                            ""
                       )
                )
            ]
        , div [ classList [ ( "dg-board-controls", True ), ( "is-open", model.controlsOpen ) ] ] (boardControls model)
        ]


boardControls : Model -> List (Html Msg)
boardControls model =
    [ input [ type_ "search", placeholder "Search Actions or Projects", value model.search, onInput SearchChanged ] []
    , button
        [ classList [ ( "is-active", model.filterOpen ) ]
        , attribute "aria-expanded" (Ui.boolAttribute model.filterOpen)
        , onClick ToggleFilters
        ]
        [ text
            (case activeRefinements model of
                0 ->
                    "Filter"

                count ->
                    "Filter (" ++ String.fromInt count ++ ")"
            )
        ]
    , Ui.labelled "Columns"
        (choices []
            groupByKey
            SetGroupBy
            model.configuration.groupBy
            (List.map (\groupBy -> ( groupBy, "Columns: " ++ Settings.groupByLabel groupBy ))
                [ GroupByStatus, GroupByProject, GroupByContext, GroupByEnergy ]
            )
        )
    , Ui.labelled "Sections"
        (choices []
            (Maybe.map groupByKey >> Maybe.withDefault "none")
            SetSections
            model.configuration.sections
            (( Nothing, "Sections: None" )
                :: ([ GroupByStatus, GroupByProject, GroupByContext, GroupByEnergy ]
                        |> List.filter ((/=) model.configuration.groupBy)
                        |> List.map (\field -> ( Just field, "Sections: " ++ Settings.groupByLabel field ))
                   )
            )
        )
    , Ui.labelled "Sort by"
        (choices []
            sortFieldKey
            SetSortField
            model.configuration.sort.field
            (List.map (\field -> ( field, "Sort: " ++ Settings.sortFieldLabel field ))
                [ SortByManual, SortByCreated, SortByDue, SortByTitle, SortByProject ]
            )
        )
    , button [ onClick ReverseSort ]
        (Ui.iconLabel
            (case model.configuration.sort.direction of
                Ascending ->
                    "↑"

                Descending ->
                    "↓"
            )
            "Reverse sort"
        )
    ]


{-| Managing a saved view is occasional, so it sits behind the picker's menu.
On the unsaved Board, saving always means naming a new view.
-}
viewMenu : Model -> Html Msg
viewMenu model =
    let
        activeName =
            model.activeViewId
                |> Maybe.andThen (Settings.findSavedView model.snapshot.settings.savedViews)
                |> Maybe.map .name
    in
    div [ class "dg-popover", attribute "role" "menu" ]
        (case activeName of
            Just name ->
                [ button [ class "dg-flat-button", attribute "role" "menuitem", onClick SaveView ] [ text ("Save changes to “" ++ name ++ "”") ]
                , button [ class "dg-flat-button", attribute "role" "menuitem", onClick SaveViewAs ] [ text "Save as new view…" ]
                , button [ class "dg-flat-button dg-popover-danger", attribute "role" "menuitem", onClick DeleteView ] [ text "Delete view" ]
                ]

            Nothing ->
                [ button [ class "dg-flat-button", attribute "role" "menuitem", onClick SaveViewAs ] [ text "Save as new view…" ] ]
        )


{-| How many ways the board is narrowed beyond search, for the Filter button.
-}
activeRefinements : Model -> Int
activeRefinements model =
    List.length model.configuration.filters
        + (if model.allProjects then
            1

           else
            0
          )
        + (case model.configuration.visibleColumns of
            AllColumns ->
                0

            OnlyColumns _ ->
                1
          )


{-| Everything that narrows the board, in one place: which Projects count, the
filters, and which columns show.
-}
filterPanel : Model -> Html Msg
filterPanel model =
    div [ class "dg-filter-panel" ]
        [ div [ class "dg-panel" ]
            [ span [ class "dg-panel-label" ] [ text "Projects" ]
            , label [ class "dg-toolbar-toggle" ]
                [ input [ type_ "checkbox", checked model.allProjects, onCheck ToggleAllProjects ] [], span [] [ text "Include inactive Projects" ] ]
            ]
        , filterBuilder model
        , columnPicker model
        ]


{-| A `select` over a union: the options are the union's values, and a choice can
only ever be one of them.
-}
choices : List (Html.Attribute msg) -> (a -> String) -> (a -> msg) -> a -> List ( a, String ) -> Html msg
choices attributes toKey toMessage current options =
    select
        (value (toKey current)
            :: onInput (\raw -> List.filter (\( candidate, _ ) -> toKey candidate == raw) options |> List.head |> Maybe.map (Tuple.first >> toMessage) |> Maybe.withDefault (toMessage current))
            :: attributes
        )
        (List.map (\( candidate, label ) -> option [ value (toKey candidate) ] [ text label ]) options)


filterBuilder : Model -> Html Msg
filterBuilder model =
    let
        draft =
            model.draft
    in
    div [ class "dg-panel dg-filter-builder" ]
        [ span [ class "dg-panel-label" ] [ text "Add filter" ]
        , choices []
            filterFieldKey
            SetFilterField
            draft.field
            [ ( FieldStatus, "Status" )
            , ( FieldProject, "Project" )
            , ( FieldContext, "Context" )
            , ( FieldEnergy, "Energy" )
            , ( FieldArea, "Area" )
            , ( FieldDue, "Due date" )
            ]
        , if draft.field == FieldDue then
            text ""

          else
            choices [] operatorKey SetFilterOperator draft.operator [ ( Is, "is" ), ( IsNot, "is not" ) ]
        , if draft.field == FieldDue then
            text ""

          else
            select [ value draft.value, onInput SetFilterValue ]
                (List.map (\( key, name ) -> option [ value key ] [ text name ]) (filterValues model))
        , if draft.field == FieldDue then
            dueControls model

          else
            text ""
        , button [ class "mod-cta", onClick AddFilter ] [ text "Add filter" ]
        ]


dueControls : Model -> Html Msg
dueControls model =
    span []
        [ choices []
            dueOperatorKey
            SetDueOperator
            model.draft.dueOperator
            [ ( OpBefore, "before" )
            , ( OpOnOrBefore, "on or before" )
            , ( OpAfter, "after" )
            , ( OpOnOrAfter, "on or after" )
            , ( OpWithinNextDays, "within next days" )
            , ( OpIsEmpty, "is empty" )
            , ( OpIsNotEmpty, "is not empty" )
            ]
        , if List.member model.draft.dueOperator [ OpIsEmpty, OpIsNotEmpty ] then
            text ""

          else
            input
                [ type_
                    (if model.draft.dueOperator == OpWithinNextDays then
                        "number"

                     else
                        "date"
                    )
                , value model.draft.dueValue
                , onInput SetDueValue
                ]
                []
        ]


filterChips : Model -> Html Msg
filterChips model =
    if List.isEmpty model.configuration.filters then
        text ""

    else
        div [ class "dg-filter-chips" ]
            (List.indexedMap
                (\index filter -> button [ class "dg-chip", onClick (RemoveFilter index) ] [ text (describeFilter model filter ++ " ×") ])
                model.configuration.filters
            )


columnPicker : Model -> Html Msg
columnPicker model =
    let
        candidates =
            columnCandidates model

        visible =
            case model.configuration.visibleColumns of
                AllColumns ->
                    List.map groupKeyString candidates

                OnlyColumns columns ->
                    columns
    in
    div [ class "dg-panel dg-column-picker" ]
        (span [ class "dg-panel-label" ] [ text "Columns" ]
            :: List.map
            (\key ->
                label []
                    [ input
                        [ type_ "checkbox"
                        , checked (List.member (groupKeyString key) visible)
                        , onCheck (\_ -> ToggleColumn key)
                        ]
                        []
                    , text (" " ++ groupLabel model key)
                    ]
            )
            candidates
        )


groupView : Model -> Group -> Html Msg
groupView model group =
    let
        dropAttributes =
            case ( model.configuration.groupBy, group.key ) of
                ( GroupByStatus, StatusGroup status ) ->
                    if status == ActionStatus.Cancelled then
                        []

                    else
                        [ Ui.preventDefaultOn "dragover" DragOver, Ui.preventDefaultOn "drop" (DropOn status) ]

                _ ->
                    []
    in
    section
        (class "dg-column" :: attribute "data-column" (groupKeyString group.key) :: dropAttributes)
        [ header [ class "dg-column-header" ]
            [ span [] [ text (groupLabel model group.key) ]
            , span [ class "dg-column-counts" ]
                [ case List.length (List.filter (needsAttention model.snapshot.today) group.actions) of
                    0 ->
                        text ""

                    count ->
                        span [ class "dg-column-attention" ]
                            [ span [ class "dg-attention-dot", attribute "aria-hidden" "true" ] []
                            , text (String.fromInt count)
                            , Ui.srOnly " need attention,"
                            ]
                , span [] [ text (String.fromInt (List.length group.actions)) ]
                ]
            ]
        , div [ class "dg-card-list" ]
            (case model.configuration.sections of
                Nothing ->
                    List.map (cardView model) group.actions

                Just field ->
                    List.map (sectionView model) (sectionsOf model field group.actions)
            )
        ]


{-| One section of a column: a heading with its count, then its cards in the
column's order.
-}
sectionView : Model -> ( GroupKey, List Action ) -> Html Msg
sectionView model ( key, actions ) =
    section [ class "dg-board-section" ]
        (Html.h3 [ class "dg-board-section-heading" ]
            [ span [] [ text (groupLabel model key) ]
            , span [ class "dg-board-section-count" ] [ text (String.fromInt (List.length actions)) ]
            ]
            :: List.map (cardView model) actions
        )


{-| A column's Actions split by another field, keeping the column's order inside
each section. Statuses and energy follow their natural order; projects and
contexts are alphabetical, with the empty section last.
-}
sectionsOf : Model -> GroupBy -> List Action -> List ( GroupKey, List Action )
sectionsOf model field actions =
    let
        keys =
            actions
                |> List.map (groupKeyOf field)
                |> List.foldl
                    (\key found ->
                        if List.member key found then
                            found

                        else
                            found ++ [ key ]
                    )
                    []
                |> List.sortBy (sectionRank model)
    in
    List.map (\key -> ( key, List.filter (\action -> groupKeyOf field action == key) actions )) keys


sectionRank : Model -> GroupKey -> ( Int, String )
sectionRank model key =
    let
        indexIn list value =
            list |> List.indexedMap Tuple.pair |> List.filter (\( _, candidate ) -> candidate == value) |> List.head |> Maybe.map Tuple.first |> Maybe.withDefault 99

        alphabetical isEmpty =
            if isEmpty then
                ( 1, "" )

            else
                ( 0, String.toLower (groupLabel model key) )
    in
    case key of
        StatusGroup status ->
            ( indexIn ActionStatus.all status, "" )

        EnergyGroup energy ->
            ( indexIn [ Just Energy.Low, Nothing, Just Energy.High ] energy, "" )

        ProjectGroup projectId ->
            alphabetical (projectId == Nothing)

        ContextGroup context ->
            alphabetical (context == Nothing)


cardView : Model -> Action -> Html Msg
cardView model action =
    let
        breadcrumb =
            action.projectId |> Maybe.andThen (Hierarchy.breadcrumbFor model.snapshot.projects)

        overdue =
            Maybe.map (\due -> due < model.snapshot.today && action.status /= ActionStatus.Done) action.due
                |> Maybe.withDefault False

        followUp =
            if action.status == ActionStatus.Waiting then
                action.followUp

            else
                Nothing

        followUpDue =
            Maybe.map (\date -> date <= model.snapshot.today) followUp |> Maybe.withDefault False
    in
    article
        [ classList
            [ ( "dg-card", True )
            , ( "is-drop-before", model.priorityDropTarget == Just action.id )
            , ( "is-follow-up-due", followUpDue )
            , ( "needs-attention", needsAttention model.snapshot.today action )
            , ( "is-done", action.status == ActionStatus.Done )
            ]
        , attribute "role" "listitem"
        , attribute "data-card" action.id
        , id (cardDomId action.id)
        , tabindex 0
        , draggable "true"
        , on "dragstart" (Decode.succeed (DragStarted action.id))
        , on "dragend" (Decode.succeed DragEnded)
        , custom "dragover" (Decode.succeed { message = DragOverCard action.id, stopPropagation = True, preventDefault = True })
        , custom "drop" (Decode.succeed { message = DropBefore action.id, stopPropagation = True, preventDefault = True })
        , onCardKey action.id
        ]
        [ div [ class "dg-card-title-row" ]
            [ Ui.labelled
                ((if action.status == ActionStatus.Done then
                    "Reopen "

                  else
                    "Mark done: "
                 )
                    ++ action.title
                )
                (input
                    [ type_ "checkbox"
                    , class "dg-card-done"
                    , checked (action.status == ActionStatus.Done)
                    , onCheck (ToggleDone action.id)
                    ]
                    []
                )
            , if needsAttention model.snapshot.today action then
                span [ class "dg-attention-dot" ] [ Ui.srOnly "Needs attention:" ]

              else
                text ""
            , span [ class "dg-card-title dg-action-card-title" ] [ text action.title ]
            , button
                [ class "dg-icon-button dg-flat-button"
                , Ui.onPointer (\x y -> Send IgnoreReply (actionMenu x y model action))
                ]
                (Ui.iconLabel "•••" ("Actions for " ++ action.title))
            ]
        , case ( action.projectId, breadcrumb ) of
            ( Just projectId, Just name ) ->
                let
                    labelled =
                        withStatusSymbol model projectId name
                in
                button [ class "dg-project-link dg-flat-button", onClick (Send IgnoreReply (Command.ShowProject projectId)) ] [ text labelled ]

            ( Just _, Nothing ) ->
                span [ class "dg-missing" ] [ text "Missing project" ]

            ( Nothing, _ ) ->
                text ""
        , div [ class "dg-card-meta" ]
            [ Ui.maybeView (Data.scheduleText model.snapshot.today action) (\schedule -> span [ class "dg-card-schedule" ] [ text ("🗓 " ++ schedule) ])
            , Ui.maybeView (Maybe.map (\context -> "@" ++ context) action.context) (\shown -> span [] [ text shown ])
            , Ui.maybeView action.energy Energy.badge
            , Ui.maybeView action.due
                (\due ->
                    -- Overdue is said in words and a symbol too, not by colour alone.
                    if overdue then
                        span [ class "is-overdue" ] [ text ("⚠ " ++ due) ]

                    else
                        span [] [ text due ]
                )
            , if action.status == ActionStatus.Waiting then
                span [] [ text ("Waiting since " ++ Maybe.withDefault "—" action.waitingSince) ]

              else
                text ""
            , Ui.maybeView followUp
                (\date ->
                    -- Like overdue, a reached follow-up is said with a symbol and words, not colour alone.
                    if followUpDue then
                        span [ class "is-follow-up-due" ] [ text ("⚑ Follow up since " ++ date) ]

                    else
                        span [] [ text ("Follow up " ++ date) ]
                )
            ]
        ]


{-| Keys pressed on the card itself; a key on its menu or Project link is theirs.
-}
onCardKey : ActionId -> Html.Attribute Msg
onCardKey actionId =
    on "keydown"
        (Decode.at [ "target", "id" ] Decode.string
            |> Decode.andThen
                (\targetId ->
                    if targetId == cardDomId actionId then
                        Decode.map (CardKey actionId) Ui.keyDecoder

                    else
                        Decode.fail "key on a child of the card"
                )
        )


cardDomId : ActionId -> String
cardDomId actionId =
    "dg-action-" ++ actionId



-- GROUPING


buildGroups : Model -> List Group
buildGroups model =
    let
        actions =
            model.snapshot.actions
                |> List.map (effectiveAction model)
                |> List.filter (matchesAll model)
                |> sortActions model

        grouped =
            List.foldl
                (\action buckets ->
                    let
                        key =
                            groupKeyOf model.configuration.groupBy action
                    in
                    Dict.update (groupKeyString key)
                        (\existing ->
                            Just ( key, action :: (Maybe.map Tuple.second existing |> Maybe.withDefault []) )
                        )
                        buckets
                )
                Dict.empty
                actions

        keys =
            case model.configuration.groupBy of
                GroupByStatus ->
                    statusColumnKeys model |> List.map StatusGroup

                GroupByEnergy ->
                    -- Low, normal (no level), high, rather than alphabetically.
                    [ EnergyGroup (Just Energy.Low), EnergyGroup Nothing, EnergyGroup (Just Energy.High) ]
                        |> List.filter (\key -> Dict.member (groupKeyString key) grouped)
                        |> applyVisible model.configuration.visibleColumns

                _ ->
                    Dict.values grouped
                        |> List.map Tuple.first
                        |> applyVisible model.configuration.visibleColumns
    in
    List.map
        (\key ->
            { key = key
            , actions = Dict.get (groupKeyString key) grouped |> Maybe.map (Tuple.second >> List.reverse) |> Maybe.withDefault []
            }
        )
        keys


{-| The status columns a status-grouped board lays out: the saved choice when the
view has one, and otherwise every status the settings put on the board.
-}
statusColumnKeys : Model -> List ActionStatus
statusColumnKeys model =
    case model.configuration.visibleColumns of
        AllColumns ->
            Settings.statusColumns model.snapshot.settings

        OnlyColumns columns ->
            List.filterMap statusFromKey columns


statusFromKey : String -> Maybe ActionStatus
statusFromKey raw =
    List.filter (\status -> ActionStatus.key status == raw) ActionStatus.all |> List.head


applyVisible : VisibleColumns -> List GroupKey -> List GroupKey
applyVisible visible keys =
    case visible of
        AllColumns ->
            keys

        OnlyColumns allowed ->
            List.filter (\key -> List.member (groupKeyString key) allowed) keys


groupKeyOf : GroupBy -> Action -> GroupKey
groupKeyOf groupBy action =
    case groupBy of
        GroupByStatus ->
            StatusGroup action.status

        GroupByProject ->
            ProjectGroup action.projectId

        GroupByContext ->
            ContextGroup action.context

        GroupByEnergy ->
            EnergyGroup action.energy


{-| The key a column is stored under, in the group buckets and in a saved view.
-}
groupKeyString : GroupKey -> String
groupKeyString key =
    case key of
        StatusGroup status ->
            ActionStatus.key status

        ProjectGroup projectId ->
            Maybe.withDefault "" projectId

        ContextGroup context ->
            Maybe.withDefault "" context

        EnergyGroup energy ->
            Maybe.map Energy.key energy |> Maybe.withDefault ""


groupLabel : Model -> GroupKey -> String
groupLabel model key =
    case key of
        StatusGroup status ->
            ActionStatus.label status

        ProjectGroup Nothing ->
            "No project"

        ProjectGroup (Just projectId) ->
            Hierarchy.breadcrumbFor model.snapshot.projects projectId
                |> Maybe.map (withStatusSymbol model projectId)
                |> Maybe.withDefault "Missing project"

        ContextGroup Nothing ->
            "No context"

        ContextGroup (Just context) ->
            capitalized context

        EnergyGroup Nothing ->
            "Normal energy"

        EnergyGroup (Just energy) ->
            Energy.symbol energy ++ " " ++ Energy.label energy


{-| Prefixes a Project name with a symbol for its status, so Actions of a Project
that is not Active stand out once the board shows every Project.
-}
withStatusSymbol : Model -> ProjectId -> String -> String
withStatusSymbol model projectId name =
    case Data.findProject projectId model.snapshot.projects |> Maybe.andThen (.status >> statusSymbol) of
        Just symbol ->
            symbol ++ " " ++ name

        Nothing ->
            name


statusSymbol : ProjectStatus -> Maybe String
statusSymbol status =
    case status of
        ProjectStatus.Active ->
            Nothing

        ProjectStatus.Backlog ->
            Just "⏸"

        ProjectStatus.Someday ->
            Just "☁"

        ProjectStatus.Completed ->
            Just "✓"

        ProjectStatus.Cancelled ->
            Just "✕"


capitalized : String -> String
capitalized value =
    String.toUpper (String.left 1 value) ++ String.dropLeft 1 value


columnCandidates : Model -> List GroupKey
columnCandidates model =
    case model.configuration.groupBy of
        GroupByStatus ->
            Settings.statusColumns model.snapshot.settings |> List.map StatusGroup

        _ ->
            let
                config =
                    model.configuration
            in
            buildGroups { model | configuration = { config | visibleColumns = AllColumns } } |> List.map .key



-- FILTERING


matchesAll : Model -> Action -> Bool
matchesAll model action =
    let
        projectText =
            action.projectId
                |> Maybe.andThen (Hierarchy.breadcrumbFor model.snapshot.projects)
                |> Maybe.withDefault ""
    in
    (model.allProjects || belongsToActiveProject model action)
        && Ui.matches model.search [ action.title, projectText ]
        && List.all (matchesFilter model action) model.configuration.filters


{-| The Actions Board is for current project work. An Action without a Project
remains a valid standalone Action; an Action whose referenced Project is missing
is not surfaced as active work.
-}
belongsToActiveProject : Model -> Action -> Bool
belongsToActiveProject model action =
    case action.projectId of
        Nothing ->
            True

        Just projectId ->
            Data.findProject projectId model.snapshot.projects
                |> Maybe.map (\project -> project.status == ProjectStatus.Active)
                |> Maybe.withDefault False


matchesFilter : Model -> Action -> Filter -> Bool
matchesFilter model action filter =
    case filter of
        ByStatus operator values ->
            applyOperator operator (List.member action.status values)

        ByProject operator values ->
            applyOperator operator (List.member action.projectId values || inSubprojectOf model values action)

        ByContext operator values ->
            applyOperator operator (List.member (Maybe.withDefault "" action.context) values)

        ByEnergy operator values ->
            applyOperator operator (List.member (Maybe.map Energy.key action.energy |> Maybe.withDefault "") values)

        ByArea operator values ->
            -- Sub-projects share their top-level Project's area.
            action.projectId
                |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects)
                |> Maybe.andThen (Hierarchy.area model.snapshot.projects)
                |> Maybe.map (\area -> List.member area values)
                |> Maybe.withDefault False
                |> applyOperator operator

        ByDue range ->
            matchesDue model range action.due


{-| A Project filter stands for the Project's whole subtree, so the Actions of
its sub-projects, at any depth, match it too.
-}
inSubprojectOf : Model -> List (Maybe ProjectId) -> Action -> Bool
inSubprojectOf model values action =
    case action.projectId |> Maybe.andThen (\projectId -> Data.findProject projectId model.snapshot.projects) of
        Just project ->
            values
                |> List.filterMap identity
                |> List.any (\rootId -> Hierarchy.isDescendantOf rootId model.snapshot.projects project)

        Nothing ->
            False


applyOperator : MatchOperator -> Bool -> Bool
applyOperator operator contains =
    case operator of
        Is ->
            contains

        IsNot ->
            not contains


matchesDue : Model -> DueRange -> Maybe String -> Bool
matchesDue model range maybeDue =
    case ( range, maybeDue ) of
        ( DueIsEmpty, Nothing ) ->
            True

        ( DueIsNotEmpty, Just _ ) ->
            True

        ( DueBefore expected, Just due ) ->
            due < expected

        ( DueOnOrBefore expected, Just due ) ->
            due <= expected

        ( DueAfter expected, Just due ) ->
            due > expected

        ( DueOnOrAfter expected, Just due ) ->
            due >= expected

        ( DueWithinDays days, Just due ) ->
            due >= model.snapshot.today && due <= addDays model.snapshot.today days

        _ ->
            False


sortActions : Model -> List Action -> List Action
sortActions model actions =
    let
        key action =
            case model.configuration.sort.field of
                SortByDue ->
                    Maybe.withDefault "9999-99-99" action.due

                SortByTitle ->
                    String.toLower action.title

                SortByProject ->
                    action.projectId
                        |> Maybe.andThen (Hierarchy.breadcrumbFor model.snapshot.projects)
                        |> Maybe.map String.toLower
                        |> Maybe.withDefault "zzzz"

                SortByCreated ->
                    action.created

                SortByManual ->
                    ""

        descending =
            model.configuration.sort.direction == Descending

        -- The drag order is one sort among the others, so choosing another field really re-sorts.
        compareActions left right =
            if model.configuration.sort.field == SortByManual then
                case ( left.priority, right.priority ) of
                    ( Just _, Just _ ) ->
                        if descending then
                            comparePriority right left

                        else
                            comparePriority left right

                    _ ->
                        -- Unranked Actions follow the ranked ones in both directions.
                        case comparePriority left right of
                            EQ ->
                                compare left.id right.id

                            unranked ->
                                unranked

            else if model.configuration.sort.field == SortByDue then
                -- An Action with no due date sorts last in both directions.
                case ( left.due, right.due ) of
                    ( Nothing, Nothing ) ->
                        compare left.id right.id

                    ( Nothing, Just _ ) ->
                        GT

                    ( Just _, Nothing ) ->
                        LT

                    ( Just leftDue, Just rightDue ) ->
                        if descending then
                            compare ( rightDue, right.id ) ( leftDue, left.id )

                        else
                            compare ( leftDue, left.id ) ( rightDue, right.id )

            else if descending then
                compare ( key right, right.id ) ( key left, left.id )

            else
                compare ( key left, left.id ) ( key right, right.id )
    in
    List.sortWith compareActions actions


{-| The Manual sort: a ranked Action always comes before an unranked one.
-}
comparePriority : Action -> Action -> Order
comparePriority left right =
    case ( left.priority, right.priority ) of
        ( Just leftPriority, Just rightPriority ) ->
            compare ( leftPriority, left.id ) ( rightPriority, right.id )

        ( Just _, Nothing ) ->
            LT

        ( Nothing, Just _ ) ->
            GT

        ( Nothing, Nothing ) ->
            EQ


{-| The order visible on the board with the dropped card moved. The host keeps
every priority that already fits it, so a drop usually rewrites one Action, and
Actions outside the current filters keep theirs.
-}
priorityOrder : Model -> ActionId -> ActionId -> List ActionId
priorityOrder model actionId targetId =
    buildGroups model
        |> List.concatMap (.actions >> List.map .id)
        |> insertBefore actionId targetId


insertBefore : ActionId -> ActionId -> List ActionId -> List ActionId
insertBefore actionId targetId actionIds =
    let
        withoutDragged =
            List.filter ((/=) actionId) actionIds
    in
    List.foldr
        (\candidate result ->
            if candidate == targetId then
                actionId :: candidate :: result

            else
                candidate :: result
        )
        []
        withoutDragged


{-| The options a value filter offers for the field the draft names.
-}
filterValues : Model -> List ( String, String )
filterValues model =
    case model.draft.field of
        FieldStatus ->
            List.map (\status -> ( ActionStatus.key status, ActionStatus.label status )) ActionStatus.all

        FieldProject ->
            ( "", "No project" )
                :: (model.snapshot.projects
                        |> List.map (\project -> ( project.id, Hierarchy.breadcrumb model.snapshot.projects project ))
                        |> List.sortBy Tuple.second
                   )

        FieldContext ->
            Data.contexts model.snapshot.actions |> List.map (\item -> ( item, item ))

        FieldEnergy ->
            ( "", "Normal energy" ) :: List.map (\energy -> ( Energy.key energy, Energy.symbol energy ++ " " ++ Energy.label energy )) Energy.all

        FieldArea ->
            Data.areas model.snapshot.projects |> List.map (\item -> ( item, item ))

        _ ->
            []


{-| The filter the builder would add, or nothing when its value never resolved.
-}
draftFilter : Model -> Maybe Filter
draftFilter model =
    let
        draft =
            model.draft
    in
    case draft.field of
        FieldDue ->
            Just (ByDue (dueRange draft))

        FieldStatus ->
            statusFromKey draft.value |> Maybe.map (\status -> ByStatus draft.operator [ status ])

        FieldProject ->
            Just
                (ByProject draft.operator
                    [ if String.isEmpty draft.value then
                        Nothing

                      else
                        Just draft.value
                    ]
                )

        FieldContext ->
            Just (ByContext draft.operator [ draft.value ])

        FieldEnergy ->
            Just (ByEnergy draft.operator [ draft.value ])

        FieldArea ->
            Just (ByArea draft.operator [ draft.value ])


{-| Adds a filter to the board's. A value filter on a field that already has one with
the same operator widens that one instead: an Action has one context, so "Context is
@Home" and "Context is @Laptop" as two filters, which must all match, would show
nothing, while one "Context is @Home or @Laptop" shows what either allows.
-}
addFilter : Filter -> List Filter -> List Filter
addFilter added filters =
    if List.any (\existing -> widen existing added /= Nothing) filters then
        List.map (\existing -> Maybe.withDefault existing (widen existing added)) filters

    else
        filters ++ [ added ]


widen : Filter -> Filter -> Maybe Filter
widen existing added =
    let
        union current extra =
            current ++ List.filter (\value -> not (List.member value current)) extra
    in
    case ( existing, added ) of
        ( ByStatus operator current, ByStatus other extra ) ->
            if operator == other then
                Just (ByStatus operator (union current extra))

            else
                Nothing

        ( ByProject operator current, ByProject other extra ) ->
            if operator == other then
                Just (ByProject operator (union current extra))

            else
                Nothing

        ( ByContext operator current, ByContext other extra ) ->
            if operator == other then
                Just (ByContext operator (union current extra))

            else
                Nothing

        ( ByEnergy operator current, ByEnergy other extra ) ->
            if operator == other then
                Just (ByEnergy operator (union current extra))

            else
                Nothing

        ( ByArea operator current, ByArea other extra ) ->
            if operator == other then
                Just (ByArea operator (union current extra))

            else
                Nothing

        _ ->
            Nothing


dueRange : FilterDraft -> DueRange
dueRange draft =
    case draft.dueOperator of
        OpBefore ->
            DueBefore draft.dueValue

        OpOnOrBefore ->
            DueOnOrBefore draft.dueValue

        OpAfter ->
            DueAfter draft.dueValue

        OpOnOrAfter ->
            DueOnOrAfter draft.dueValue

        OpWithinNextDays ->
            DueWithinDays (String.toInt draft.dueValue |> Maybe.withDefault 7)

        OpIsEmpty ->
            DueIsEmpty

        OpIsNotEmpty ->
            DueIsNotEmpty


describeFilter : Model -> Filter -> String
describeFilter model filter =
    case filter of
        ByDue range ->
            describeDue range

        ByStatus operator values ->
            described "Status" operator (List.map ActionStatus.label values)

        ByProject operator values ->
            described "Project"
                operator
                (List.map
                    (\maybeId ->
                        case maybeId of
                            Nothing ->
                                "No project"

                            Just projectId ->
                                Hierarchy.breadcrumbFor model.snapshot.projects projectId |> Maybe.withDefault "Missing project"
                    )
                    values
                )

        ByContext operator values ->
            described "Context" operator values

        ByEnergy operator values ->
            described "Energy"
                operator
                (List.map (\raw -> Energy.fromKey raw |> Maybe.map Energy.label |> Maybe.withDefault "normal") values)

        ByArea operator values ->
            described "Area" operator values


described : String -> MatchOperator -> List String -> String
described field operator names =
    field
        ++ (case operator of
                Is ->
                    " is "

                IsNot ->
                    " is not "
           )
        ++ String.join " or " names


describeDue : DueRange -> String
describeDue range =
    case range of
        DueBefore date ->
            "Due before " ++ date

        DueOnOrBefore date ->
            "Due on or before " ++ date

        DueAfter date ->
            "Due after " ++ date

        DueOnOrAfter date ->
            "Due on or after " ++ date

        DueWithinDays days ->
            "Due within " ++ String.fromInt days ++ " days"

        DueIsEmpty ->
            "Due is empty"

        DueIsNotEmpty ->
            "Due is not empty"



-- MENU


actionMenu : Float -> Float -> Model -> Action -> Command
actionMenu x y model action =
    let
        statusEntries =
            List.map
                (\status -> MenuItem (tick (status == action.status) ++ ActionStatus.label status) (Command.SetActionStatus action.id status))
                ActionStatus.all

        contexts =
            Data.contexts model.snapshot.actions

        contextEntries =
            List.map
                (\context ->
                    MenuItem (tick (action.context == Just context) ++ "@" ++ context) (Command.SetActionContext action.id context)
                )
                contexts
    in
    Command.ShowMenu x
        y
        (statusEntries
            ++ (if List.isEmpty contexts then
                    []

                else
                    MenuSeparator :: contextEntries
               )
            ++ [ MenuSeparator
               , MenuItem "Edit…" (Command.EditActionModal action.id)
               , MenuItem "Delete Action…" (Command.TrashAction action.id)
               ]
        )


tick : Bool -> String
tick marked =
    if marked then
        "✓ "

    else
        ""



-- KEYS FOR SELECT CONTROLS


groupByKey : GroupBy -> String
groupByKey groupBy =
    case groupBy of
        GroupByStatus ->
            "status"

        GroupByProject ->
            "project"

        GroupByContext ->
            "context"

        GroupByEnergy ->
            "energy"


sortFieldKey : SortField -> String
sortFieldKey field =
    case field of
        SortByManual ->
            "manual"

        SortByCreated ->
            "created"

        SortByDue ->
            "due"

        SortByTitle ->
            "title"

        SortByProject ->
            "project"


operatorKey : MatchOperator -> String
operatorKey operator =
    case operator of
        Is ->
            "in"

        IsNot ->
            "notIn"


filterFieldKey : FilterField -> String
filterFieldKey field =
    case field of
        FieldStatus ->
            "status"

        FieldProject ->
            "project"

        FieldContext ->
            "context"

        FieldEnergy ->
            "energy"

        FieldArea ->
            "area"

        FieldDue ->
            "due"


dueOperatorKey : DueOperator -> String
dueOperatorKey operator =
    case operator of
        OpBefore ->
            "before"

        OpOnOrBefore ->
            "onOrBefore"

        OpAfter ->
            "after"

        OpOnOrAfter ->
            "onOrAfter"

        OpWithinNextDays ->
            "withinNextDays"

        OpIsEmpty ->
            "isEmpty"

        OpIsNotEmpty ->
            "isNotEmpty"



-- HELPERS


removeAt : Int -> List a -> List a
removeAt index values =
    List.indexedMap Tuple.pair values |> List.filter (\( candidate, _ ) -> candidate /= index) |> List.map Tuple.second


{-| Calendar arithmetic on `yyyy-mm-dd`, through the day number of the proleptic
Gregorian calendar.
-}
addDays : String -> Int -> String
addDays date amount =
    case String.split "-" date |> List.filterMap String.toInt of
        [ year, month, day ] ->
            dateFromOrdinal (ordinal year month day + amount)

        _ ->
            date


ordinal : Int -> Int -> Int -> Int
ordinal year month day =
    let
        adjustedYear =
            if month <= 2 then
                year - 1

            else
                year

        adjustedMonth =
            if month <= 2 then
                month + 12

            else
                month
    in
    365 * adjustedYear + adjustedYear // 4 - adjustedYear // 100 + adjustedYear // 400 + (153 * (adjustedMonth - 3) + 2) // 5 + day - 1


dateFromOrdinal : Int -> String
dateFromOrdinal value =
    let
        era =
            value // 146097

        dayOfEra =
            value - era * 146097

        yearOfEra =
            (dayOfEra - dayOfEra // 1460 + dayOfEra // 36524 - dayOfEra // 146096) // 365

        rawYear =
            yearOfEra + era * 400

        dayOfYear =
            dayOfEra - (365 * yearOfEra + yearOfEra // 4 - yearOfEra // 100)

        monthPrime =
            (5 * dayOfYear + 2) // 153

        day =
            dayOfYear - (153 * monthPrime + 2) // 5 + 1

        month =
            monthPrime
                + (if monthPrime < 10 then
                    3

                   else
                    -9
                  )

        year =
            rawYear
                + (if month <= 2 then
                    1

                   else
                    0
                  )

        pad number =
            String.padLeft 2 '0' (String.fromInt number)
    in
    String.fromInt year ++ "-" ++ pad month ++ "-" ++ pad day



-- DECODING


hostEventDecoder : Decoder HostEvent
hostEventDecoder =
    Decode.field "type" Decode.string
        |> Decode.andThen
            (\kind ->
                case kind of
                    "snapshot" ->
                        Decode.map SnapshotEvent (Decode.field "snapshot" Data.snapshotDecoder)

                    "command-result" ->
                        Decode.map Replied Host.outcomeDecoder

                    _ ->
                        Decode.fail ("Unknown host event: " ++ kind)
            )
